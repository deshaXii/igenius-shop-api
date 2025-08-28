// src/utils/calculateProfit.js
// profit = finalPrice - sum(parts.cost)
// techShare = commissionPct% من profit (commissionPct من User أو Settings أو 50%)
// shopShare = profit - techShare
function calcProfit({ finalPrice = 0, parts = [], commissionPct = 50 }) {
  const partsCost = (parts || []).reduce(
    (s, p) => s + (Number(p.cost) || 0),
    0
  );
  const profit = Number(finalPrice || 0) - partsCost;
  const safeProfit = Math.max(0, profit);
  const techShare = Math.round(safeProfit * commissionPct * 100) / 100 / 100;
  const shopShare = Math.round((safeProfit - techShare) * 100) / 100;
  return { profit: safeProfit, partsCost, techShare, shopShare };
}
module.exports = calcProfit;
