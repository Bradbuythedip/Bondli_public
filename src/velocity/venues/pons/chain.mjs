// ═══ PONS on Robinhood Chain: addresses, ABI, curve math, log decoding ═══
// Robinhood Chain is an Arbitrum-stack Ethereum L2 (chain id 4663, gas and quote asset ETH).
// PONS V2 launches a fixed 1,000,000,000-token ERC-20 into its own constant-product bonding-curve
// contract; trades hit that curve until the real quote reserve reaches graduationThreshold, then
// the pool moves to Uniswap V4. Source: github.com/ponsdotdev/ponsfamily (contractsV2/src/v2).
import { Interface, id as keccakId, formatUnits, parseUnits } from "ethers";

export const CHAIN_ID = 4663;
export const DEFAULT_RPC_URL = "https://rpc.mainnet.chain.robinhood.com"; // public, rate-limited; PONS_RPC_URL for a paid one
export const EXPLORER = "https://robinhoodchain.blockscout.com";
export const FACTORY = "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e";        // PonsV2LaunchFactory
export const LAUNCH_AND_BUY = "0xe33e9e479df8802cb0866d5d05258bec4cf62948"; // PonsV2LaunchAndBuy router
export const MEME_HOOK = "0xe5e702641ea86f4ae6cc3cdaed2b886f976be044";      // PonsV2MemeHook (graduated pools)
export const TOKEN_SUPPLY = 1_000_000_000;
export const TOKEN_DECIMALS = 18;
export const BASIS_POINTS = 10_000;
// The factory can tax buys in a launch's first seconds at up to 99% (snipe tax, MAX_SNIPE_TAX_SECONDS = 60):
// a buy inside that window is a donation. The edge refuses entries younger than this.
export const SNIPE_TAX_WINDOW_MS = 60_000;

export const FACTORY_ABI = [
  "event TokenLaunched(address indexed token, address indexed curve, address indexed deployer, address pairToken, uint256 launchConfigId, uint256 graduationThreshold)",
  "event PoolGraduated(address indexed token, uint256 positionId, uint256 tokenAmount, uint256 pairTokenAmount)",
  "function getLaunchedToken(address token) view returns (tuple(address token, address curve, address deployer, address pairToken, uint256 launchConfigId, uint256 graduationThreshold, bool graduated))",
];
export const CURVE_ABI = [
  "event CurveBuy(address indexed buyer, address indexed recipient, uint256 quoteIn, uint256 tokensOut, uint256 fee, uint256 tax)",
  "event CurveSell(address indexed seller, address indexed recipient, uint256 tokensIn, uint256 quoteOut, uint256 fee, uint256 tax)",
  "event CurveCompleted(address recipient, uint256 quoteOut, uint256 tokenOut)",
  "function buy(uint256 quoteIn, uint256 minTokensOut, address recipient) payable returns (uint256 tokensOut)",
  "function sell(uint256 tokensIn, uint256 minQuoteOut, address recipient) returns (uint256 quoteOut)",
  "function getReserves() view returns (uint256 quoteReserve_, uint256 tokenReserve_)",
  "function realQuoteReserve() view returns (uint256)",
  "function readyToGraduate() view returns (bool)",
  "function graduated() view returns (bool)",
  "function feeBps() view returns (uint256)",
  "function creatorTaxBps() view returns (uint256)",
  "function phantomQuote() view returns (uint256)",
  "function graduationThreshold() view returns (uint256)",
  "function token() view returns (address)",
  "function pairToken() view returns (address)",
  "function isNativeQuote() view returns (bool)",
];
export const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function decimals() view returns (uint8)",
  "function name() view returns (string)",
  "function symbol() view returns (string)",
];
export const factoryIface = new Interface(FACTORY_ABI);
export const curveIface = new Interface(CURVE_ABI);
export const erc20Iface = new Interface(ERC20_ABI);
export const TOPICS = Object.freeze({
  TokenLaunched: keccakId("TokenLaunched(address,address,address,address,uint256,uint256)"),
  CurveBuy: keccakId("CurveBuy(address,address,uint256,uint256,uint256,uint256)"),
  CurveSell: keccakId("CurveSell(address,address,uint256,uint256,uint256,uint256)"),
  CurveCompleted: keccakId("CurveCompleted(address,uint256,uint256)"),
  PoolGraduated: keccakId("PoolGraduated(address,uint256,uint256,uint256)"),
});

export const toEth = (wei) => Number(formatUnits(BigInt(wei), 18));
export const toWei = (eth) => parseUnits(Number(eth).toFixed(18), 18);
export const toTokens = (units, decimals = TOKEN_DECIMALS) => Number(formatUnits(BigInt(units), decimals));

/** Decode one factory or curve log into a plain record, or null for anything else. */
export function decodeLog(log) {
  const topic = log?.topics?.[0];
  try {
    if (topic === TOPICS.TokenLaunched) {
      const e = factoryIface.parseLog({ topics: log.topics, data: log.data });
      return { kind: "launch", token: e.args.token.toLowerCase(), curve: e.args.curve.toLowerCase(), deployer: e.args.deployer.toLowerCase(), pairToken: e.args.pairToken.toLowerCase(), graduationThreshold: toEth(e.args.graduationThreshold), block: log.blockNumber, tx: log.transactionHash };
    }
    if (topic === TOPICS.CurveBuy || topic === TOPICS.CurveSell) {
      const e = curveIface.parseLog({ topics: log.topics, data: log.data });
      const buy = topic === TOPICS.CurveBuy;
      return {
        kind: buy ? "buy" : "sell", curve: log.address.toLowerCase(), wallet: (buy ? e.args.buyer : e.args.seller).toLowerCase(),
        quote: toEth(buy ? e.args.quoteIn : e.args.quoteOut), tokens: toTokens(buy ? e.args.tokensOut : e.args.tokensIn),
        fee: toEth(e.args.fee), tax: toEth(e.args.tax), block: log.blockNumber, tx: log.transactionHash, logIndex: log.index ?? log.logIndex,
      };
    }
    if (topic === TOPICS.CurveCompleted) return { kind: "complete", curve: log.address.toLowerCase(), block: log.blockNumber, tx: log.transactionHash };
    if (topic === TOPICS.PoolGraduated) { const e = factoryIface.parseLog({ topics: log.topics, data: log.data }); return { kind: "graduated", token: e.args.token.toLowerCase(), block: log.blockNumber, tx: log.transactionHash }; }
  } catch { return null; }
  return null;
}

/**
 * Constant-product curve, quote-denominated fees taken off the quote leg on both sides.
 * Reserves are the VIRTUAL reserves getReserves() returns (phantomQuote included), in ETH and tokens.
 */
export function curveBuyQuote({ quoteReserve, tokenReserve }, quoteIn, totalFeeBps = 0) {
  const spent = quoteIn * (1 - totalFeeBps / BASIS_POINTS);
  const tokensOut = tokenReserve - (quoteReserve * tokenReserve) / (quoteReserve + spent);
  const spot = quoteReserve / tokenReserve, avg = spent / tokensOut;
  return { tokensOut, avgPrice: quoteIn / tokensOut, spot, slippage_bps: (avg / spot - 1) * 1e4, feeQuote: quoteIn - spent };
}
export function curveSellQuote({ quoteReserve, tokenReserve }, tokensIn, totalFeeBps = 0) {
  const gross = quoteReserve - (quoteReserve * tokenReserve) / (tokenReserve + tokensIn);
  const quoteOut = gross * (1 - totalFeeBps / BASIS_POINTS);
  const spot = quoteReserve / tokenReserve, avg = gross / tokensIn;
  return { quoteOut, avgPrice: quoteOut / tokensIn, spot, slippage_bps: (1 - avg / spot) * 1e4, feeQuote: gross - quoteOut };
}
/** Market cap in the quote asset from virtual reserves: spot price times the fixed supply. */
export function mcapQuote({ quoteReserve, tokenReserve }) { return tokenReserve > 0 ? (quoteReserve / tokenReserve) * TOKEN_SUPPLY : 0; }
/** 0..1 progress to graduation from the real quote reserve. */
export function curveProgress(realQuoteReserve, graduationThreshold) { return graduationThreshold > 0 ? Math.min(1, Math.max(0, realQuoteReserve / graduationThreshold)) : 0; }
