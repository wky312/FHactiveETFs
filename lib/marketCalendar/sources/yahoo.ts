// eslint-disable-next-line @typescript-eslint/no-require-imports
const YahooFinance = require('yahoo-finance2').default;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const yf: any = new YahooFinance({ suppressNotices: ['ripHistorical', 'yahooSurvey'] });
