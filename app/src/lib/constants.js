export const API = "https://bondli-production.up.railway.app";
export const X_URL = "https://x.com/shitanalystXBT";
export const DISCORD_URL = "https://discord.gg/SHueKKXRkv";
// The house token. Holding one waives the performance fee; the server decides, this is only the label
// and the link. $BNDLI is an SPL mint on Solana -- the same wallet you sign in with holds it, so there
// is nothing extra to connect and it counts whichever chain you trade. Set VITE_BNDLI_MINT once it is
// launched to turn the ticker into a link to its pump.fun page. The old VITE_JEFF_MINT name is still
// honoured for one release so a build whose env was set under the previous name keeps its link.
export const TOKEN_NAME = "Bondli";
export const TOKEN_SYMBOL = "BNDLI";
export const TOKEN_MINT = import.meta.env?.VITE_BNDLI_MINT || import.meta.env?.VITE_JEFF_MINT || "";
export const TOKEN_URL = TOKEN_MINT ? `https://pump.fun/coin/${TOKEN_MINT}` : X_URL;
export const M = "'IBM Plex Mono','JetBrains Mono','Fira Code',monospace";
export const S = "'Nunito','DM Sans','Segoe UI',system-ui,sans-serif";
// Every token image goes through the backend proxy: IPFS gateways block browser hotlinks.
export const imgUrl = (u, mint) => u && u.startsWith("data:") ? u : (u || mint) ? API + "/api/img?url=" + encodeURIComponent(u || "") + (mint ? "&mint=" + mint : "") : "";
