// The one word the front page has for a token. Its whole job is that the word is true: a refusal
// about the clock ("you are late", "not enough buyers yet") is not a rug finding and must never be
// shown as one, and a token that is still filling up should say so — unless a rug rule spoke, which
// always wins, because the cost of calling a rug "still cooking" is somebody's money.
export const VERDICT_TAGS = Object.freeze(["hot", "rug", "cooking", "late", "fewbuyers", "new", "small", "weak", "close"]);

/**
 * @param v        a judgeToken verdict: { enter, gate, reasons }
 * @param cooking  whether the token is currently reading as a slow cook
 */
export function tagFor(v, cooking = false) {
  if (!v) return "weak";
  if (v.enter) return "hot";
  if (v.gate === "rug") return "rug";
  if (cooking) return "cooking";
  const why = v.reasons || [];
  if (v.gate === "timing") return why.includes("TOO_FEW_BUYERS") ? "fewbuyers" : why.includes("TOO_YOUNG") ? "new" : "late";
  if (v.gate === "viability") return why.includes("MCAP_BELOW_FLOOR") ? "small" : "weak";
  if (v.gate === "window" || v.gate === "confidence") return "close";
  return "weak";
}
