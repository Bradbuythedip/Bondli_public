// The share card: a 1200x630 picture of one won close, drawn in the browser and handed to the phone's
// share sheet (or saved, on a desktop). A tweet intent cannot attach an image, so the "share" link
// beside this one carries the words and this carries the picture; both say the same thing.
//
// The card exists only for a win with real money behind it. A paper close is not a result and a loss
// is on the record, not on a poster -- the callers check canShareCard before they show the button and
// shareCard checks it again, so the rule is not one component's opinion.
import { D } from "./theme.js";
import { M, S } from "./constants.js";

export const CARD_W = 1200, CARD_H = 630;
export const canShareCard = c => !!c && !c.paper && Number(c.pnl_pct) > 0;

const held = ms => ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))}s` : `${Math.round(ms / 60_000)}m`;
// A row with no hold time (nothing passes one today, but the card must never print "in NaNm").
const heldClause = ms => Number.isFinite(ms) ? ` in ${held(ms)}` : "";
const tickerOf = c => (c.ticker || String(c.instrument || "").slice(0, 6)).replace(/^\$/, "");
const shortTx = tx => tx && tx.length > 12 ? `${tx.slice(0, 4)}…${tx.slice(-4)}` : tx || "";
/** '+42% on $CAT in 4m' -- the same sentence the tweet opens with, so the picture and the words agree. */
export const cardTitle = c => `+${Number(c.pnl_pct).toFixed(0)}% on $${tickerOf(c)}${heldClause(Number(c.held_ms))}`;

/** The frog, or the logo when the painting is not there. Same-origin, so the canvas stays untainted
 *  and toBlob is allowed to read it back. */
function loadImage(src, size) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    // An SVG with only a viewBox has no intrinsic size, and a canvas will not draw a 0x0 image.
    if (size) { img.width = size[0]; img.height = size[1]; }
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`could not load ${src}`));
    img.src = src;
  });
}
async function frog() {
  try { return { img: await loadImage("/fren.png"), painting: true }; }
  catch { return { img: await loadImage("/bondli-logo.svg", [200, 260]), painting: false }; }
}

/** Draw the card and return it as a PNG blob. `T` is the page palette so the card is the page. */
export async function renderShareCard(c, T = D) {
  if (!canShareCard(c)) throw new Error("only a won, live close gets a card");
  const cv = document.createElement("canvas");
  cv.width = CARD_W; cv.height = CARD_H;
  const g = cv.getContext("2d");
  // Ground: the page's own colour, with the raised-card colour behind the text block.
  g.fillStyle = T.bg; g.fillRect(0, 0, CARD_W, CARD_H);
  const grad = g.createLinearGradient(0, 0, CARD_W, CARD_H);
  grad.addColorStop(0, T.sf + "00"); grad.addColorStop(1, T.sf + "ff");
  g.fillStyle = grad; g.fillRect(0, 0, CARD_W, CARD_H);

  // The frog, in a ring, on the left third. A missing painting shows the logo, not a hole.
  const { img, painting } = await frog();
  const cx = 300, cy = 315, r = 210;
  g.save();
  g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.closePath(); g.clip();
  if (painting) {
    // Cover-fit, anchored a little above centre, the same crop the loading screen uses.
    const s = Math.max((r * 2) / img.width, (r * 2) / img.height);
    const w = img.width * s, h = img.height * s;
    g.drawImage(img, cx - w / 2, cy - h * 0.42, w, h);
  } else {
    g.fillStyle = T.sf; g.fillRect(cx - r, cy - r, r * 2, r * 2);
    const h = r * 1.3, w = h * (200 / 260);
    g.drawImage(img, cx - w / 2, cy - h / 2, w, h);
  }
  g.restore();
  g.lineWidth = 6; g.strokeStyle = T.gn; g.beginPath(); g.arc(cx, cy, r + 6, 0, Math.PI * 2); g.stroke();

  // The words. One number, one sentence, one address.
  const x = 580;
  g.textBaseline = "alphabetic"; g.textAlign = "left";
  g.fillStyle = T.ft; g.font = `700 26px ${S}`;
  g.fillText("a bot closed this trade", x, 170);
  g.fillStyle = T.gn; g.font = `900 132px ${M}`;
  g.fillText(`+${Number(c.pnl_pct).toFixed(0)}%`, x - 6, 300);
  g.fillStyle = T.tx; g.font = `900 52px ${S}`;
  g.fillText(`on $${tickerOf(c)} in ${held(c.held_ms)}`, x, 370);
  g.fillStyle = T.dm; g.font = `800 40px ${S}`;
  g.fillText("the bot did it, not me", x, 440);
  g.fillStyle = T.ft; g.font = `600 26px ${M}`;
  if (c.tx) g.fillText(`tx ${shortTx(c.tx)} · on-chain`, x, 500);
  g.fillStyle = T.tx; g.font = `900 34px ${S}`; g.textAlign = "right";
  g.fillText("bondli.fun", CARD_W - 60, CARD_H - 52);
  g.fillStyle = T.ft; g.font = `600 20px ${S}`; g.textAlign = "left";
  g.fillText("memecoins can go to zero", 60, CARD_H - 52);

  return new Promise((resolve, reject) => cv.toBlob(b => b ? resolve(b) : reject(new Error("the canvas gave no image")), "image/png"));
}

/** Share the card through the system sheet where there is one (phones), else save it. Returns what
 *  happened: "shared", "saved" or "cancelled" (the person closed the sheet, which is not an error). */
export async function shareCard(c, T = D) {
  const blob = await renderShareCard(c, T);
  const file = new File([blob], `bondli-${tickerOf(c).toLowerCase() || "call"}.png`, { type: "image/png" });
  const text = `${cardTitle(c)}. The bot did it, not me 🐸`;
  if (typeof navigator !== "undefined" && navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], text, title: "Bondli" }); return "shared"; }
    catch (e) { if (e?.name === "AbortError") return "cancelled"; /* else fall through to the download */ }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = file.name; a.rel = "noopener";
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return "saved";
}
