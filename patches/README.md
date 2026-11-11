# Dependency patches

`structured-headers@2.1.1.patch` fixes date parsing when another parameter or
dictionary member follows the date. It uses the integer parser, rejects decimal
dates and retains its 15-digit limit. The source fix follows the open upstream
[PR #89](https://github.com/evert/structured-headers/pull/89); ESM and CommonJS
release builds are patched too because the installed package executes those.

Keep the pin and Bun `patchedDependencies` entry until a released upstream version
includes this fix. Then upgrade, remove the patch entry/file, regenerate the lock,
and run `apps/server/test/content-digest.test.ts`, including the date parameter
vectors in `spec/vectors/content-digest.json`. Do not remove the regression cases.
All container dependency stages copy this directory before frozen installation.
