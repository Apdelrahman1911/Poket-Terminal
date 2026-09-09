#!/usr/bin/env python3
"""Report natural-GC time windows/trends; completion alone is NOT leak acceptance."""
import json
from pathlib import Path
import statistics
import sys
ROOT = Path(__file__).resolve().parents[1]
evidence = Path(sys.argv[1]) if len(sys.argv) > 1 else Path((ROOT / '.runtime/evidence/latest-memory.txt').read_text().strip())
manifest = json.loads((evidence / 'manifest.json').read_text())
assert manifest.get('nativeCleanupVersion') == 2, 'This analysis requires OS-backed native cleanup evidence; do not reclassify the superseded counter-only run'
samples = [json.loads(line) for line in (evidence / 'samples.jsonl').read_text().splitlines()]
MIB = 1024 * 1024
metrics = {
    'nodeRssMiB': lambda s: s['node']['rss']/MIB,
    'nodePssMiB': lambda s: s['node']['pss']/MIB,
    'nodeHeapMiB': lambda s: s['stats']['memory']['heapUsed']/MIB,
    'nodeExternalMiB': lambda s: s['stats']['memory']['external']/MIB,
    'nodeArrayBuffersMiB': lambda s: s['stats']['memory']['arrayBuffers']/MIB,
    'tmuxRssMiB': lambda s: s['tmux']['rss']/MIB if s['tmux'] else None,
    'tmuxPssMiB': lambda s: s['tmux']['pss']/MIB if s['tmux'] else None,
    'browserHeapMiB': lambda s: s['browser']['heapUsed']/MIB if s['browser'] else None,
    'browserDOMNodes': lambda s: s['browser']['counters']['nodes'] if s['browser'] else None,
    'browserListeners': lambda s: s['browser']['counters']['jsEventListeners'] if s['browser'] else None,
    'browserDocuments': lambda s: s['browser']['counters']['documents'] if s['browser'] else None,
    'browserRendererRssMiB': lambda s: s['browser']['renderer']['rss']/MIB if s['browser'] else None,
    'browserRendererPssMiB': lambda s: s['browser']['renderer']['pss']/MIB if s['browser'] else None,
}
def aggregate(rows):
    out = {}
    for key, read in metrics.items():
        points = [(s['seconds'], read(s)) for s in rows if read(s) is not None]
        if not points: continue
        xs, ys = zip(*points); meanx, meany = statistics.mean(xs), statistics.mean(ys)
        denominator = sum((x - meanx)**2 for x in xs)
        slope = sum((x - meanx)*(y - meany) for x, y in points) / denominator if denominator else 0
        out[key] = {'min': min(ys), 'median': statistics.median(ys), 'max': max(ys), 'first': ys[0], 'last': ys[-1], 'olsPerMinute': slope*60, 'endMinusStart': ys[-1]-ys[0]}
    return out
soak = [s for s in samples if s['phase'] == 'soak_real_mobile_xterm_4096_Bps']
start = soak[0]['seconds']
windows = []
for n in range(6):
    rows = [s for s in soak if n*300 <= s['seconds']-start < (n+1)*300]
    windows.append({'soakMinuteRange': [n*5, (n+1)*5], 'samples': len(rows), 'metrics': aggregate(rows)})
cool = [s for s in samples if s['phase'] == 'cooldown_no_browser_clients']
warm = [s for s in samples if s['phase'] == 'mobile_warm_baseline_after_cycles']
idle = [s for s in samples if s['phase'] == 'twenty_shells_detached']
last = cool[-1]
bridges = last['stats']['bridges']
fields = ['connections','attachments','ptys','retiringPtys','controllers','outstandingBytes','pendingInputBytes','transportBytes','subscriptions','inputTimers','resizeJobs']
zero = all(all(s['stats']['bridges'][k] == 0 for k in fields) and s['stats']['bridges']['created'] == s['stats']['bridges']['disposed'] for s in cool)
native_zero = all(s['stats']['ptyFds'] == 0 and s['stats']['handles'].get('ReadStream', 0) == 0 and not s['attachProcesses']['processes'] for s in cool)
assert zero and native_zero, 'Actual native or logical terminal resources retained during cooldown'
assert not last['backendChildren']['processes'], 'Final sample retains actual backend children'
active_rows = [s for s in soak if s['browser']]
assert all(s['stats']['ptyFds'] == 1 and s['stats']['handles'].get('ReadStream', 0) == 1 and len(s['attachProcesses']['processes']) == 1 for s in active_rows), 'Native classifier must observe every known active terminal'
assert json.loads((evidence/'active-native-cross-check.json').read_text())['result'] == 'PASS'
assert json.loads((evidence/'backend-shutdown.json').read_text())['graceful'], 'Benchmark cleanup forced backend termination'
assert last['stats']['sessions']['managedRunning'] == 20, 'Detached jobs did not survive'
node_identity = {(s['node']['pid'], s['node']['startTicks']) for s in samples}
assert len(node_identity) == 1, 'Backend restarted during benchmark'
full_window_metrics = aggregate(soak)
last_half = aggregate([s for s in soak if s['seconds']-start >= 900])
comparison = {}
for key, read in metrics.items():
    a = [read(s) for s in warm if read(s) is not None]; b = [read(s) for s in cool if read(s) is not None]
    if a and b: comparison[key] = {'warmMedian': statistics.median(a), 'cooldownLast60sMedian': statistics.median([read(s) for s in cool if s['seconds'] >= cool[-1]['seconds']-60]), 'delta': statistics.median([read(s) for s in cool if s['seconds'] >= cool[-1]['seconds']-60])-statistics.median(a)}
high = json.loads((evidence / 'high-rate-stress.json').read_text())
high_report = {'durationSeconds': high[-1]['seconds'], 'nodeRssPeakMiB': max(s['node']['rss'] for s in high)/MIB, 'nodePssPeakMiB': max(s['node']['pss'] for s in high)/MIB, 'tmuxRssPeakMiB': max(s['tmux']['rss'] for s in high)/MIB, 'tmuxPssPeakMiB': max(s['tmux']['pss'] for s in high)/MIB, 'tmuxFirstRssMiB': high[0]['tmux']['rss']/MIB, 'tmuxFinalRssMiB': high[-1]['tmux']['rss']/MIB, 'nativeDetachBySeconds': next((s['seconds'] for s in high if s['bridges']['ptys'] == 0 and s['ptyFds'] == 0 and not s['attachProcesses']['processes'] and not s['handles'].get('ReadStream')), None), 'finalPtyFds': high[-1]['ptyFds'], 'finalAttachProcesses': high[-1]['attachProcesses'], 'producerFinal': high[-1]['producer'], 'peakOutstandingBytes': max(s['bridges']['peakOutstandingBytes'] for s in high)}
assert high_report['nativeDetachBySeconds'] is not None, 'Non-ACK stress did not release native attachment'
kdf = json.loads((evidence/'kdf-burst.json').read_text())
kdf_report = {'responses': kdf['responses'], 'peakVerifying': kdf['peakVerifying'], 'beforeRssMiB': kdf['before']['node']['rss']/MIB, 'sampledPeakRssMiB': max(s['proc']['rss'] for s in kdf['samples'])/MIB, 'sampledPeakPssMiB': max(s['proc']['pss'] for s in kdf['samples'])/MIB, 'kernelHighWaterBeforeMiB': kdf['kernelHighWaterBefore']/MIB, 'kernelHighWaterAfterMiB': kdf['kernelHighWaterAfter']/MIB, 'note': kdf['highWaterNote']}
report = {'status': 'SMOKE_ONLY_NOT_ACCEPTANCE' if manifest['smoke'] else 'MEASURED_REQUIRES_HUMAN_TREND_REVIEW', 'commit': manifest['commit'], 'tree': manifest['tree'], 'naturalGC': True, 'backendRestarts': len(node_identity)-1, 'soakSeconds': soak[-1]['seconds']-start, 'soakFiveMinuteWindows': windows, 'soakWholeTrend': full_window_metrics, 'soakLast15MinuteTrend': last_half, 'warmVsCooldown': comparison, 'cyclePhaseTrends': {name: aggregate([s for s in samples if s['phase'] == name]) for name in ['mobile_before_cycles', '100_connect_disconnect_cycles', '200_session_switches', '50_mobile_hidden_frozen_visible_cycles', 'mobile_warm_baseline_after_cycles']}, 'cooldown': {'seconds': cool[-1]['seconds']-cool[0]['seconds'], 'metrics': aggregate(cool), 'finalBridges': bridges, 'finalPtyFds': last['stats']['ptyFds'], 'finalAttachProcesses': last['attachProcesses'], 'finalAllBackendChildren': last['backendChildren'], 'finalHandles': last['stats']['handles'], 'initialDetachedHandles': idle[-1]['stats']['handles'], 'allTerminalResourcesZero': zero and native_zero, 'createdEqualsDisposed': bridges['created']==bridges['disposed'], 'jobsRemainAlive': 20}, 'highRateNonAck': high_report, 'kdfBurst': kdf_report,
    'budgetsToInvestigate': {'warmIdleNodeRssAtMost120MiB': max(s['node']['rss']/MIB for s in cool) <= 120, 'normalMobileHeapAtMost64MiB': max(s['browser']['heapUsed']/MIB for s in soak) <= 64}, 'interpretation': 'Review medians/slopes across post-warmup windows, not only cold-to-final RSS. V8/native plateaus and periodic GC must be distinguished from monotonic retained growth. Test-host renderer memory is not physical-phone RAM.'}
(evidence/'trends.json').write_text(json.dumps(report, indent=2)+'\n')
print(json.dumps(report, indent=2))
