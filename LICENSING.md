# Licensing and third-party source

No permissive license has been assigned to the original PocketTerminal or
PocketDesktop application code by this publication. The owner must decide its
license; repository access alone is not a grant to redistribute that code.

The pinned dependency `@novnc/novnc` 1.7.0 has its own MPL-2.0 licensing and vendor
notices. Modifications in `desktop/patches/novnc-1.7.0.patch` are MPL-2.0, retain
upstream notices, and do not relicense the rest of this application. See
[patch provenance](desktop/patches/README.md). Build output includes noVNC AUTHORS,
MPL and other bundled vendor notices in `client/LICENSES.txt`, plus the complete
patched source tree under the isolated candidate's `source/vendor/novnc`.

Keep the patch, upstream hashes, lockfile, complete patched corresponding source
and notices available to recipients alongside any redistributed desktop bundle.
The provisioner installs runtime client assets, not a source-download endpoint;
the operator must separately retain/provide corresponding source. Other npm and
Ubuntu packages retain their respective licenses. Dependency installation/build
is not permission to relicense their code or the original application.
