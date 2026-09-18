// T28: the viral surfaces keep the house rules. The tape on the landing page is every bot's closes,
// so what a row carries is a privacy decision: a ticker, a percentage and a hold time say what
// happened; a wallet, a user or a position id would say who. Paper closes ride the tape flagged, so
// the page can print "paper" and never a number that looks like money. The share card is drawn only
// for a won, live close. The lore section links the frog's own history. And the palette is measured:
// every ink on a card clears WCAG 4.5:1, computed here rather than trusted from the comment.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { D, L, BLUE, CHIP_TINT } from "../../app/src/lib/theme.js";
import { en, zh, LANGS, makeT, DICT } from "../../app/src/lib/i18n.js";

const SITE = fs.readFileSync(path.resolve("app/src/Simple.jsx"), "utf8");
const HUB = fs.readFileSync(path.resolve("src/velocity/hub.mjs"), "utf8");
const CARD = fs.readFileSync(path.resolve("app/src/lib/sharecard.js"), "utf8");
const THEME = fs.readFileSync(path.resolve("app/src/lib/theme.js"), "utf8");
const I18N = fs.readFileSync(path.resolve("app/src/lib/i18n.js"), "utf8");
const MAIN = fs.readFileSync(path.resolve("app/src/main.jsx"), "utf8");

test("T28: a tape row names a ticker, a result and a hold time -- never a wallet, a user or a position id", () => {
  const start = HUB.indexOf("const tape = ");
  assert.ok(start > 0, "pulse() builds a tape");
  const row = HUB.slice(start, HUB.indexOf(";", HUB.indexOf(".map(c => ({", start)));
  assert.match(row, /\.slice\(0, tapeLimit\)/);
  assert.match(row, /\{ ts: c\.ts, venue: c\.venue, ticker: c\.ticker, instrument: c\.instrument, pnl_pct: c\.pnl_pct, held_ms: c\.held_ms, paper: c\.paper, reason: c\.reason \}/, "the row is exactly these eight fields");
  assert.doesNotMatch(row, /wallet|user|positionId|pnl_usd/, "nothing that sizes a bankroll or points at a person");
  assert.match(HUB, /tapeLimit = 12/, "the last twelve, as the label on the page says");
  assert.match(HUB, /best, recent, tape, windowMs/);
  // The tape is drawn from every close, paper included; paper is excluded only from the money figures.
  assert.match(row, /\[\.\.\.closes\]/, "paper closes are on the tape (flagged), not filtered out");
});

test("T28: the site renders paper rows as paper, in the neutral ink, and says only what the label promises", () => {
  const tape = SITE.slice(SITE.indexOf("function Tape("), SITE.indexOf("function Heartbeat("));
  assert.ok(tape.length > 200, "found the tape component");
  assert.match(tape, /const col = c\.paper \|\| c\.pnl_pct === 0 \? T\.dm : c\.pnl_pct > 0 \? T\.gn : T\.rd;/, "paper is never green or red, and a flat close is neither");
  assert.match(tape, /\{c\.paper \? <span style=\{\{ color: T\.ft \}\}>\{t\("tape\.paper"\)\}<\/span> : null\}/, "paper is labelled paper");
  assert.equal(en["tape.paper"], "paper · ");
  assert.match(tape, /\{t\("tape\.label"\)\}/);
  assert.match(en["tape.label"], /every bot, last 12 closes/);
  assert.match(tape, /data-tape-copy aria-hidden="true"/, "the seamless copy is hidden from readers");
  assert.match(SITE, /<Tape rows=\{d\.tape\} T=\{T\} \/>/, "the tape hangs off the pulse");
  // Losses stay on the strip in the callouts' own words.
  assert.match(tape, /exitWord\(c\.reason\)/);
  assert.match(SITE, /"stopped" : \/stall\|doa\/\.test\(w\) \? "cut flat" : \/max_hold\|timeout\|time\/\.test\(w\) \? "timed out"/);
  // Reduced motion: the strip stands still and wraps rather than scrolling. The rows live inside the
  // two child spans of .tape, which are inline flex rows, so the wrap has to be set on those spans or
  // the twelve rows stay on one clipped line; and the edge fade comes off, or the first and last row
  // of each wrapped line would be faded out with no motion to bring them back.
  const rm = /@media \(prefers-reduced-motion: reduce\)\{([\s\S]*?)\n\}/.exec(THEME)?.[1] || "";
  assert.match(rm, /\.tape\{animation:none;width:auto;flex-wrap:wrap/);
  assert.match(rm, /\.tape>span\{flex-wrap:wrap;justify-content:center\}/, "the rows' own containers wrap");
  assert.match(rm, /\.tapebox\{mask-image:none;-webkit-mask-image:none\}/, "no edge fade when nothing moves");
  assert.match(rm, /\.tape \[data-tape-copy\]\{display:none\}/);
  assert.match(THEME, /\.tapebox\{mask-image:linear-gradient\(90deg,transparent,#000 8%,#000 92%,transparent\)/, "the fade is a class, so the media query can clear it");
  assert.match(tape, /className="card tapebox"/); assert.doesNotMatch(tape, /maskImage/, "no inline mask the stylesheet cannot reach");
  // On a phone there is no hover; a touch holds the strip still too.
  assert.match(THEME, /\.tape:hover,\.tape:active,\.tape:focus-within\{animation-play-state:paused\}/);
});

test("T28: the share card is drawn only for a won, live close, and is offered only there", () => {
  assert.match(CARD, /export const canShareCard = c => !!c && !c\.paper && Number\(c\.pnl_pct\) > 0;/);
  assert.match(CARD, /if \(!canShareCard\(c\)\) throw/, "the renderer checks the rule itself, not just the button");
  assert.match(CARD, /cv\.width = CARD_W; cv\.height = CARD_H;/);
  assert.match(CARD, /export const CARD_W = 1200, CARD_H = 630;/);
  assert.match(CARD, /loadImage\("\/fren\.png"\)/);
  assert.match(CARD, /loadImage\("\/bondli-logo\.svg", \[200, 260\]\)/, "a missing painting shows the logo, not a hole");
  assert.match(CARD, /navigator\.canShare\?\.\(\{ files: \[file\] \}\)/, "the phone's share sheet when there is one");
  assert.match(CARD, /a\.download = file\.name/, "a download everywhere else");
  assert.match(CARD, /"the bot did it, not me"/);
  assert.match(CARD, /"bondli\.fun"/);
  assert.match(CARD, /if \(c\.tx\) g\.fillText\(`tx \$\{shortTx\(c\.tx\)\}/, "the tx short hash when the row is a call");
  const btn = SITE.slice(SITE.indexOf("function ShareCardBtn("), SITE.indexOf("const exitWord"));
  assert.match(btn, /if \(!canShareCard\(c\)\) return null;/);
  // Wired beside both existing share links: the user's own closes and the public calls.
  assert.match(SITE, /\{c\.pnl_usd > 0 && <ShareCardBtn T=\{T\} c=\{c\} onError=\{m => say\(m, "error"\)\} \/>\}/, "a failure reaches the page's toast");
  assert.match(btn, /catch \(e\) \{ const m = t\("share\.cardFail"/, "and is never swallowed");
  assert.match(CARD, /const heldClause = ms => Number\.isFinite\(ms\) \? ` in \$\{held\(ms\)\}` : "";/, "no hold time, no 'in NaNm'");
  assert.match(SITE, /<ShareCardBtn small T=\{T\} c=\{\{ pnl_pct: c\.result\.pnl_pct, ticker: c\.ticker, instrument: c\.instrument, held_ms: c\.result\.held_ms, tx: c\.tx \}\} \/>/);
});

test("T28: the lore section names the frog's sources and opens them safely", () => {
  assert.match(SITE, /\{t\("lore\.title"\)\}/);
  assert.equal(en["lore.title"], "Where the frog comes from");
  assert.match(SITE, /<Lore T=\{T\} \/>/);
  const links = /const LORE_LINKS = \[([\s\S]*?)\];/.exec(SITE)?.[1] || "";
  for (const href of ["https://pepe.vip", "https://mattfurie.com", "https://en.wikipedia.org/wiki/Boy%27s_Club_(comics)", "https://en.wikipedia.org/wiki/Feels_Good_Man"]) assert.ok(links.includes(`"${href}"`), href);
  const lore = SITE.slice(SITE.indexOf("function Lore("), SITE.indexOf("function Watch("));
  assert.match(lore, /LORE_LINKS\.map\(\(\[l, href\]\) => <a key=\{href\} href=\{href\} target="_blank" rel="noopener"/);
  assert.match(SITE, /const LORE_LINES = \["lore\.1", "lore\.2", "lore\.3", "lore\.4"\];/);
  assert.match(en["lore.4"], /No association with Matt Furie/, "the disclaimer is on the page");
  assert.match(zh["lore.4"], /Matt Furie/, "and in Chinese it still names him");
});

// The Chinese page is the English page: one set of keys, two dictionaries, every placeholder the
// same on both sides, and every string the components ask for present in English at least. The
// tweet and the share card stay English whatever the page shows.
test("T28: the two dictionaries cover the same keys with the same placeholders, and the page reads only keys that exist", () => {
  assert.deepEqual(LANGS, ["en", "zh"]);
  const ek = Object.keys(en), zk = Object.keys(zh);
  assert.deepEqual(zk.filter(k => !(k in en)), [], "zh has no key en lacks");
  assert.deepEqual(ek.filter(k => !(k in zh)), [], "every English string has a Chinese one");
  const slots = v => typeof v === "function" ? "fn" : [...String(v).matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort().join(",");
  for (const k of ek) assert.equal(slots(zh[k]), slots(en[k]), `placeholders of ${k}`);
  // Every key the site asks for by literal is defined.
  const used = [...SITE.matchAll(/\bt\("([a-z][\w. ]*)"/g)].map(m => m[1]);
  assert.ok(used.length > 150, `the site reads ${used.length} keys`);
  assert.deepEqual(used.filter(k => !(k in en)), [], "no key without an English string");
  // Filling works, a missing key comes back as itself, and Chinese falls through to English.
  const t = makeT("zh"), e = makeT("en");
  assert.equal(e("pulse.counts", { judged: 3, gos: 1 }), "3 judged · 1 taken");
  assert.equal(t("pulse.counts", { judged: 3, gos: 1 }), "已评估 3 · 已出手 1");
  assert.equal(e("live.bots", { n: 1 }), "1 bot trading"); assert.equal(e("live.bots", { n: 2 }), "2 bots trading");
  assert.equal(t("no.such.key"), "no.such.key");
  assert.equal(makeT("xx")("hero.title"), en["hero.title"], "an unknown language is English");
  assert.equal(DICT.zh, zh);
  // The money lines are sober and exact in both languages.
  assert.equal(en["footer.risk"], "Memecoins can go to zero; only trade what you can lose.");
  assert.equal(zh["footer.risk"], "Meme 币可能归零；只用你亏得起的钱交易。");
  assert.match(en["panel.paperDesc"], /pretend money/); assert.match(zh["panel.paperDesc"], /假的钱/);
  // The tweet text and the share card never go through the page's language.
  assert.match(SITE, /const shareText = \(c\) => `\$\{c\.pnl_pct >= 0 \? "\+" : ""\}\$\{Number\(c\.pnl_pct\)\.toFixed\(0\)\}% on \$\$\{\(c\.ticker \|\| c\.instrument\.slice\(0, 6\)\)\.replace\(\/\^\\\$\/, ""\)\} in \$\{held\(c\.held_ms\)\}\. The bot did it, not me 🐸`;/);
  assert.match(SITE, /const held = \(ms, t = tEn\) =>/, "a hold time with no translator is English");
  assert.doesNotMatch(CARD, /i18n/);
  // The language is chosen above the page, remembered per device, and the document says which it is in.
  assert.match(MAIN, /<LangProvider><Simple \/><\/LangProvider>/);
  assert.match(I18N, /localStorage\.getItem\(STORE_KEY\)/); assert.match(I18N, /const STORE_KEY = "bondli_lang";/);
  assert.match(I18N, /\/\^zh\/i\.test\(l\)/, "a Chinese browser starts in Chinese");
  assert.match(I18N, /document\.documentElement\.lang = lang === "zh" \? "zh-CN" : "en"/);
  assert.match(SITE, /\{LANGS\.map\(l => <button key=\{l\} onClick=\{\(\) => setLang\(l\)\} aria-pressed=\{lang === l\}/, "the switch in the header");
  assert.doesNotMatch(SITE, /FREN|NOTAFLY/); assert.doesNotMatch(I18N, /FREN|NOTAFLY/);
});

// WCAG 2.x relative luminance and contrast ratio, the same arithmetic the palette comment cites.
const lum = hex => { const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(c => c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
// What the browser paints when `fg` at the two-digit hex `alpha` sits over `under`: a plain sRGB mix.
const blend = (fg, alpha, under) => { const a = parseInt(alpha, 16) / 255; return "#" + [1, 3, 5].map(i => Math.round(parseInt(fg.slice(i, i + 2), 16) * a + parseInt(under.slice(i, i + 2), 16) * (1 - a)).toString(16).padStart(2, "0")).join(""); };

test("T28: every ink and state clears 4.5:1 on a card, in both rooms; black clears it on the button", () => {
  for (const [name, T] of [["D", D], ["L", L]]) {
    for (const k of ["tx", "dm", "ft", "gn", "rd", "yl"]) {
      const r = ratio(T[k], T.sf);
      assert.ok(r >= 4.5, `${name}.${k} ${T[k]} on card ${T.sf} is ${r.toFixed(2)}`);
      assert.ok(ratio(T[k], T.bg) >= 4.5, `${name}.${k} on the ground`);
    }
    assert.ok(ratio("#000000", T.gn) >= 4.5, `${name}: black on the green button`);
    assert.ok(ratio(BLUE, T.sf) >= 4.5, `${name}: the chain chip's blue on a card is ${ratio(BLUE, T.sf).toFixed(2)}`);
    // The composites the page really draws on. The chip's blue sits on a tint of itself over the
    // card; the ground inks sit on the scrim over the painting, whose brightest pixel is near white,
    // so the top stop of the scrim over pure white is the worst case for anything in the top band
    // (the hero subtitle at 16px, the tape label at 10px, the footer at 12px on a short page).
    const chip = ratio(BLUE, blend(BLUE, CHIP_TINT.slice(7), T.sf));
    assert.ok(chip >= 4.5, `${name}: the chain chip's blue on its own tint over a card is ${chip.toFixed(2)}`);
    const top = /linear-gradient\(180deg,\$\{T\.bg\}([0-9a-f]{2}) 0%/.exec(THEME)?.[1];
    assert.ok(top, "the scrim's top stop is in the stylesheet");
    for (const k of ["ft", "dm", "tx"]) {
      const r = ratio(T[k], blend(T.bg, top, "#ffffff"));
      assert.ok(r >= 4.5, `${name}.${k} over the scrim's top stop on a white pixel of the painting is ${r.toFixed(2)}`);
    }
  }
  assert.match(SITE, /style=\{\{ \.\.\.muted, fontSize: 16, marginTop: 10 \}\}>\{t\("hero\.sub"\)\}/, "the hero subtitle is the faint ink on the ground, so it is in the measurement above");
  assert.equal(CHIP_TINT, BLUE + "0c");
  // The comment's figures are the measured ones, to one decimal, so the file cannot drift from itself.
  const said = /inks sit at ([\d.]+) \/ ([\d.]+) \/ ([\d.]+) and the three states at ([\d.]+) \(green\) \/ ([\d.]+) \(red\) \/\n\/\/ ([\d.]+) \(yellow\)/.exec(THEME);
  assert.ok(said, "the palette comment states its ratios");
  const got = ["tx", "dm", "ft", "gn", "rd", "yl"].map(k => ratio(D[k], D.sf).toFixed(1));
  assert.deepEqual(said.slice(1, 7), got, "the comment's ratios are the measured ones");
});
