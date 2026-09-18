import { createContext } from "react";
// The OG Pepe site's green world, seen through the coffee-frog painting. pepe.vip is one flat,
// saturated meme-green page with white type and chunky outlined boxes; the frog with the coffee is
// an oxblood room with one cream cup in it. This palette is the first seen through the second: a deep
// forest ground rather than black, so a scrim of it over /fren.png (88% at the top of the viewport,
// 93% by 40%, 97% at the foot) blends to a warm dark olive and the red of his room survives as
// something like firelight under the green; cards that are the
// same green a shade lighter; the positive state is the OG's mid green pushed light enough to be
// text; the loss is a warm coral rather than a neon red, because a trading screen that shouts is
// harder to read, not easier.
//
// Contrast is measured, not eyeballed (scratchpad/contrast.py, WCAG 2.x relative luminance). Against
// a card the three inks sit at 12.5 / 8.6 / 5.8 and the three states at 7.7 (green) / 6.0 (red) /
// 9.3 (yellow), so every one of them clears 4.5:1 -- the faint ink that carries every age, market cap
// and buyer count included. Black on the green button is 11.8. The ground inks are also measured
// where the painting shows through: the faint ink over the top of the scrim on a pure white pixel
// (the cup's highlight is 0.98 luminance) is 4.9 here and 4.5 in the light room, which is why the
// top stop is 88% and not less.
export const D = { bg: "#0b2214", sf: "#153322", bd: "rgba(255,255,255,.14)", gn: "#62d97e", rd: "#ff8a80", yl: "#f7d15a", tx: "#eef7ea", dm: "#b9d3b8", ft: "#8fb094" };
// The same green in a lighter room: the ground and cards lift, the colours lift with them so the
// ratios hold (6.4 / 5.2 / 7.4 for the states, 9.5 / 7.2 / 5.2 for the inks). Black on green: 13.3.
export const L = { bg: "#143a22", sf: "#1e4a30", bd: "rgba(255,255,255,.18)", gn: "#7ee394", rd: "#ffa199", yl: "#f9db78", tx: "#f4faf1", dm: "#c9dfc8", ft: "#a3c2a7" };
// The OG site's sky-blue accent. Used where something needs to read as a third thing -- neither good
// nor bad, just other (the chain chips). 6.7 on the dark card, 5.0 on the light one; the chip draws
// the blue on a 5% tint of itself over the card, and on that composite it is 6.2 / 4.6 -- a 12% tint
// took the light room down to 4.0, so the tint is CHIP_TINT and nothing darker.
export const BLUE = "#66bdff";
export const CHIP_TINT = BLUE + "0c";
// The OG mid green itself, for a fill with the D ground colour as ink (4.8; the L ground only manages
// 3.6, so never that) -- never as text on a card. Nothing draws it yet; it is here so a button in the
// OG's own green has a measured pairing when one is wanted.
export const PEPE = "#4c9a2a";
export const TC = createContext(D);
export function css(T) { return `
*{box-sizing:border-box;margin:0;padding:0}
html{-webkit-text-size-adjust:100%;-webkit-tap-highlight-color:transparent}
body{background:${T.bg};color:${T.tx};overflow-x:hidden;-webkit-font-smoothing:antialiased}
/* The frog is the ground, not a card. The painting sits fixed behind the whole page, under a scrim in
   the ground colour so every surface keeps the contrast it was measured at; the cards are translucent
   and blurred so he shows through them. With no /fren.png the scrim alone is the ground. */
body::before{content:"";position:fixed;inset:0;z-index:-2;background:${T.bg} url(/fren.png) center 28%/cover no-repeat}
body::after{content:"";position:fixed;inset:0;z-index:-1;background:linear-gradient(180deg,${T.bg}e0 0%,${T.bg}ec 40%,${T.bg}f7 100%)}
.card{background:${T.sf}f5;backdrop-filter:blur(16px) saturate(1.05);-webkit-backdrop-filter:blur(16px) saturate(1.05)}
input,button{font-family:inherit;-webkit-appearance:none}
::-webkit-scrollbar{width:2px}::-webkit-scrollbar-thumb{background:${T.bd};border-radius:4px}
/* The tape: one strip of closes drifting left. The content is rendered twice back to back so the
   loop has no seam; the speed is slow on purpose, it is a pulse, not a stock ticker. */
.tape{display:flex;width:max-content;animation:tape 48s linear infinite}
.tape:hover,.tape:active,.tape:focus-within{animation-play-state:paused}
/* The strip's ends fade so a row entering or leaving does not cut off hard; the fade comes off under
   reduced motion, where nothing enters or leaves and the first and last item of a line must be read. */
.tapebox{mask-image:linear-gradient(90deg,transparent,#000 8%,#000 92%,transparent);-webkit-mask-image:linear-gradient(90deg,transparent,#000 8%,#000 92%,transparent)}
@keyframes tape{from{transform:translateX(0)}to{transform:translateX(-50%)}}
@keyframes shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}
@keyframes imgin{from{opacity:0;transform:scale(1.06)}to{opacity:1;transform:scale(1)}}
@keyframes gp{0%,100%{box-shadow:0 0 0 0 ${T.gn}33}70%{box-shadow:0 0 0 5px ${T.gn}00}}
@keyframes fly{0%,100%{transform:translateY(0) rotate(-6deg)}50%{transform:translateY(-10px) rotate(-2deg)}}
@keyframes bootspin{to{transform:rotate(360deg)}}
@keyframes bootrise{0%{opacity:0;transform:translateY(10px) scale(.94)}100%{opacity:1;transform:translateY(0) scale(1)}}
@keyframes bootword{0%{opacity:0;transform:translateY(6px)}100%{opacity:.75;transform:translateY(0)}}
@keyframes bootout{to{opacity:0;visibility:hidden}}
@keyframes bootbar{0%{transform:translateX(-100%)}100%{transform:translateX(300%)}}
@media (prefers-reduced-motion: reduce){
  [data-boot]{animation:bootout .2s .2s forwards!important}
  [data-boot] *{animation:none!important}
  .tape{animation:none;width:auto;flex-wrap:wrap;justify-content:center}
  .tape>span{flex-wrap:wrap;justify-content:center}
  .tapebox{mask-image:none;-webkit-mask-image:none}
  .tape [data-tape-copy]{display:none}
}
`; }
