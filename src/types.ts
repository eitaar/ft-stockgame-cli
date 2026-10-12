/** Shared DTOs for the FT Stock Picking Game API. */

export type FundRef = [fid: number, fname: string, active: boolean, leagues: Array<[number, string]>];

export interface PlayerRef {
  id: number;
  name: string;
  confirmed: boolean;
  followers: number;
}

export interface UserData {
  active: boolean;
  userId?: number;
  player?: PlayerRef;
  /** per-account secret used by the realtime fund feed */
  secret?: string;
  funds?: FundRef[];
}

export interface FundState {
  _v?: number;
  /** value */
  v: number;
  /** base */
  b: number;
  reweighted: boolean;
  /** current picks: instrument key -> percent */
  order: Record<string, number>;
  /** scheduled picks */
  next_opt?: Record<string, number> | null;
  sellList?: Record<string, [number, number | null]>;
  sState?: Record<string, [number, number | null]>;
  aState?: {
    sellRatio?: number;
    holds?: Record<string, [number, number | null]>;
    waits?: Record<string, unknown>;
  };
  ticks?: Array<[number, number]>;
  history?: unknown[];
  pcts?: Record<string, number | null>;
  pos?: [number | null, number];
}

/** [lid, lname, x, y] as returned by GetLeagues */
export type LeagueTuple = [number, string, number, number];

export interface LeaguePage {
  owned: boolean;
  canJoin: boolean;
  canLeave: boolean;
  lname?: string;
  negs?: unknown[];
}

/** [fid, fname, active, pid, pname] */
export type LeagueFund = [number, string, boolean, number, string];

export interface LeagueFundList {
  name?: string;
  funds?: LeagueFund[];
  ress?: Record<string, number>;
}

export interface ActivityEntry {
  timeUtc: number;
  contents: {
    type: string;
    player?: PlayerRef;
    targetPlayer?: PlayerRef;
    fid?: number;
    fname?: string;
    [key: string]: unknown;
  };
}

export interface PlayerData {
  player: PlayerRef;
  followers: PlayerRef[];
  following: PlayerRef[];
  activity: ActivityEntry[];
  funds: FundRef[];
}

export interface PlayerSearchResult {
  pid: number;
  pname: string;
  funds: Array<{ fid: number; fname: string }>;
}

export interface Negotiation {
  pid: number;
  pname: string;
  fid: number;
  fname: string;
  lid: number;
  lname: string;
  fdecision: string;
  ldecision: string;
  updated: number;
  league?: { lid: number; lname: string; type: string; countsToMax: boolean };
}

export interface Exchange {
  id: number;
  name: string;
  displayName: string;
}

export interface Stock {
  id: number;
  eid: string;
  ticker: string;
  exchangeId: number;
  displayName: string;
  isin?: string | null;
  gics?: string | null;
  currency?: string | null;
}

export interface Universe {
  utcTimestamp: number;
  exchanges: Record<string, Exchange>;
  stocks: Record<string, Stock>;
  etfs?: Record<string, Stock>;
}

export interface SessionData {
  cookie?: string;
  token?: string;
  extId?: string;
  userId?: number | string;
  updatedAt?: string;
}

export interface JwtClaims {
  extId?: string;
  uid?: string;
  isB2b?: boolean;
  isB2c?: boolean;
  exp?: number;
  iat?: number;
  [key: string]: unknown;
}
