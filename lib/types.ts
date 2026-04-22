export interface Holding {
  stockid: string;
  stockname: string;
  qshare: number;
  mvalue: number;
  prate_addaccint: number;
  country: string;
  ftype: string;
}

export interface HoldingsResponse {
  date: string;
  holdings: Holding[];
}
