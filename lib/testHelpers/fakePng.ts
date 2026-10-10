/** Passes the signing page's PNG checks (header and size) without being a
 * real drawing. */
export const FAKE_PNG = "data:image/png;base64," + Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.alloc(200, 1)]).toString("base64");
