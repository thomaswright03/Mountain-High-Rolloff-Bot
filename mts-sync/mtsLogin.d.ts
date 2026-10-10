// playwright isn't a root devDependency (it lives in mts-sync/package.json's
// own node_modules) — `any` here avoids requiring root tsc to resolve its
// types just for this one param, consistent with these Playwright scripts
// staying loosely typed.
export function loginToMts(page: any): Promise<void>;
