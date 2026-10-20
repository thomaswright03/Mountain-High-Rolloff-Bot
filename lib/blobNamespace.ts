// One rule for "live or test" Blob folders, shared by Vercel and the
// GitHub Actions job. Vercel sets VERCEL_ENV; GitHub Actions doesn't, so the
// workflow sets BLOB_NAMESPACE=production instead. Either one means live.

export function isLiveNamespace(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.BLOB_NAMESPACE) return env.BLOB_NAMESPACE === "production";
  return env.VERCEL_ENV === "production";
}

/** `name` when live, `test-name` otherwise. */
export function blobFolder(name: string, env: NodeJS.ProcessEnv = process.env): string {
  return isLiveNamespace(env) ? name : `test-${name}`;
}
