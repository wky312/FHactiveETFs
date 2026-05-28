export interface Stock {
  ticker: string;   // e.g. "2330.TW"
  stockid: string;  // e.g. "2330"
  name: string;
  marketCap: number;   // TWD, in 億 (100M)
  price: number | null;
}

export interface RankedStock extends Stock {
  rank: number;
  inFund: boolean;
}

export interface RebalancePrediction {
  additions: RankedStock[];      // rank ≤50, not in fund (top 5)
  addAlternates: RankedStock[];  // next 3 after additions
  deletions: RankedStock[];      // in fund but rank >50, worst first (top 5)
  delAlternates: RankedStock[];  // in fund, ranked 48-50 (at risk)
  rankedAll: RankedStock[];
  memberCount: number;
  fetchedAt: string;
}

export function buildPrediction(
  rankedStocks: Stock[],          // sorted by marketCap desc
  currentMembers: Set<string>     // set of stockid strings
): RebalancePrediction {
  const rankedAll: RankedStock[] = rankedStocks.map((s, i) => ({
    ...s,
    rank: i + 1,
    inFund: currentMembers.has(s.stockid),
  }));

  // Additions: top 50 by market cap but not yet in 0050
  const addCandidates = rankedAll.filter(s => s.rank <= 50 && !s.inFund);
  const additions     = addCandidates.slice(0, 5);
  // Alternates: remaining top-50 non-members first (higher priority), then rank 51–60
  const addAlternates = [
    ...addCandidates.slice(5),
    ...rankedAll.filter(s => s.rank > 50 && s.rank <= 60 && !s.inFund),
  ].slice(0, 8 - additions.length);

  // Deletions: currently in 0050 but ranked below 50
  // Sort worst-ranked first (most likely to be cut)
  const delCandidates = rankedAll
    .filter(s => s.rank > 50 && s.inFund)
    .sort((a, b) => b.rank - a.rank);
  const deletions = delCandidates.slice(0, 5);

  // Borderline: in fund but sitting at rank 48-50 (at risk of falling out)
  const delAlternates = rankedAll.slice(47, 50).filter(s => s.inFund);

  return {
    additions,
    addAlternates,
    deletions,
    delAlternates,
    rankedAll,
    memberCount: currentMembers.size,
    fetchedAt: new Date().toISOString(),
  };
}
