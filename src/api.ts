import { HTTP_BASE, ORIGIN, GAME_URL } from './config.js';
import type {
  LeagueFundList,
  LeaguePage,
  LeagueTuple,
  Negotiation,
  PlayerData,
  PlayerSearchResult,
  Universe,
  UserData,
} from './types.js';

export class ApiError extends Error {
  status: number;
  body: unknown;
  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

type Order = Record<string, number>;

interface CallOptions {
  body?: unknown;
  raw?: boolean;
  retry?: boolean;
}

export class Api {
  token?: string;
  onUnauthorized?: () => Promise<string | null>;

  constructor(token?: string, opts: { onUnauthorized?: () => Promise<string | null> } = {}) {
    this.token = token;
    this.onUnauthorized = opts.onUnauthorized;
  }

  async #call(
    method: string,
    path: string,
    { body, raw = false, retry = true }: CallOptions = {},
  ): Promise<any> {
    const headers: Record<string, string> = { Origin: ORIGIN, Referer: GAME_URL };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const url = path.startsWith('http') ? path : HTTP_BASE + path;
    const res = await fetch(url, init);
    const text = await res.text();
    let json: any;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
    // Token expired or revoked mid-session: refresh once and retry, transparently.
    if ((res.status === 401 || res.status === 403) && retry && this.onUnauthorized) {
      const fresh = await this.onUnauthorized();
      if (fresh) {
        this.token = fresh;
        return this.#call(method, path, { body, raw, retry: false });
      }
    }
    if (!res.ok) throw new ApiError(`${method} ${path} -> HTTP ${res.status}`, res.status, json);
    return raw ? json : (json?.result ?? json);
  }

  get<T = unknown>(path: string, opts?: CallOptions): Promise<T> {
    return this.#call('GET', path, opts) as Promise<T>;
  }

  post<T = unknown>(path: string, body?: unknown, opts?: CallOptions): Promise<T> {
    return this.#call('POST', path, { body, ...opts }) as Promise<T>;
  }

  // ---- identity ----------------------------------------------------------
  userdata(): Promise<UserData> {
    return this.get<UserData>('fantasyfunds/userdata');
  }

  player(pid: number | string): Promise<PlayerData> {
    return this.get<PlayerData>(`FantasyFunds/PlayerData/${pid}`);
  }

  badges(pid: number | string): Promise<unknown> {
    return this.get(`FantasyFunds/PlayerBadges?playerId=${pid}`);
  }

  searchPlayers(term: string): Promise<PlayerSearchResult[]> {
    return this.get<PlayerSearchResult[]>(`FantasyFunds/searchplayerfund?term=${encodeURIComponent(term)}`);
  }

  // ---- universe / market -------------------------------------------------
  async universe(): Promise<{ overview: Universe; traded: Record<string, boolean> }> {
    const [overview, traded] = await Promise.all([
      this.get<Universe>('v1/invest-hubs/overview'),
      this.get<Record<string, boolean>>('FantasyFunds/GetAllTradedStocks'),
    ]);
    return { overview, traded };
  }

  // ---- leagues -----------------------------------------------------------
  leagues(): Promise<LeagueTuple[]> {
    return this.get<LeagueTuple[]>('FantasyFunds/GetLeagues');
  }

  officialLeagues(): Promise<unknown> {
    return this.get('official-leagues');
  }

  leaguePage(lid: number | string): Promise<LeaguePage> {
    return this.get<LeaguePage>(`FantasyFunds/GetLeaguePage?leagueId=${lid}`);
  }

  leagueFunds(lid: number | string): Promise<LeagueFundList> {
    return this.get<LeagueFundList>(`FantasyFunds/LeagueFundList?leagueId=${lid}`);
  }

  leagueFundResults(lid: number | string): Promise<unknown> {
    return this.get(`FantasyFunds/leaguefundresultlist?leagueId=${lid}`);
  }

  createLeague(leagueName: string): Promise<number> {
    return this.post<number>('FantasyFunds/CreateLeague', { leagueName });
  }

  deleteLeague(leagueId: number | string): Promise<boolean> {
    return this.post<boolean>('FantasyFunds/DeleteLeague', { leagueId: Number(leagueId) });
  }

  leaveLeague(leagueId: number | string, fundId: number | string): Promise<unknown> {
    return this.post('FantasyFunds/LeaveLeague', {
      leagueId: Number(leagueId),
      fundId: Number(fundId),
    });
  }

  // ---- funds / picks -----------------------------------------------------
  fundNegotiations(fid: number | string): Promise<unknown> {
    return this.get(`FantasyFunds/GetFundNegotiations?fundId=${fid}`);
  }

  historicalFundPerformance(fid: number | string): Promise<unknown> {
    return this.get(`FantasyFunds/historical-fund-performance?fid=${fid}`);
  }

  reweight(fid: number | string, order: Order): Promise<unknown> {
    return this.post('FantasyFunds/ReweighSelectedFund/', { fundId: Number(fid), order });
  }

  cancelReweight(fid: number | string): Promise<unknown> {
    return this.post('FantasyFunds/CancelReweighSelectedFund', { fundId: Number(fid) });
  }

  createFund(fundName: string, order: Order): Promise<unknown> {
    return this.post('FantasyFunds/CreateFund', {
      fundName,
      orderMapStr: JSON.stringify(order),
    });
  }

  registerPlayerWithFund(
    details: { playerName: string; fundName: string },
    order: Order,
  ): Promise<unknown> {
    return this.post('FantasyFunds/RegisterPlayerWithFund', {
      registrationDataStr: JSON.stringify(details),
      orderMapStr: JSON.stringify(order),
    });
  }

  deleteSelf(): Promise<unknown> {
    return this.post('FantasyFunds/DeleteSelf', {});
  }

  // ---- social ------------------------------------------------------------
  follow(pid: number | string): Promise<unknown> {
    return this.post('FantasyFunds/Follow', { playerId: Number(pid) });
  }

  unfollow(pid: number | string): Promise<unknown> {
    return this.post('FantasyFunds/Unfollow', { playerId: Number(pid) });
  }

  privateActivity(): Promise<unknown> {
    return this.get('FantasyFunds/PrivateActivity');
  }

  // ---- negotiations (new leagues system) ---------------------------------
  playerMeta(): Promise<unknown> {
    return this.get('FantasyFunds/new-negs/player-meta');
  }

  playerNegotiations(): Promise<{ playerNegotiationsWithLeagues?: Negotiation[] }> {
    return this.get('FantasyFunds/new-negs/player-negotiations');
  }

  leagueNegotiations(lid: number | string): Promise<unknown> {
    return this.get(`FantasyFunds/new-negs/league-negotiations?lid=${lid}`);
  }

  searchToInvite(lid: number | string, term: string): Promise<unknown> {
    return this.get(
      `FantasyFunds/new-negs/league-search-to-invite?lid=${lid}&term=${encodeURIComponent(term)}`,
    );
  }

  #negs(action: string, fid: number | string, lid: number | string): Promise<unknown> {
    return this.post(`FantasyFunds/new-negs/${action}?fid=${fid}&lid=${lid}`);
  }

  fundJoinLeague(fid: number | string, lid: number | string) {
    return this.#negs('do-fund-join-league', fid, lid);
  }
  fundRequestToJoin(fid: number | string, lid: number | string) {
    return this.#negs('do-fund-request-to-join-league', fid, lid);
  }
  fundLeaveLeague(fid: number | string, lid: number | string) {
    return this.#negs('do-fund-leave-league', fid, lid);
  }
  fundRejectInvite(fid: number | string, lid: number | string) {
    return this.#negs('do-fund-reject-invite', fid, lid);
  }
  fundCancelRequest(fid: number | string, lid: number | string) {
    return this.#negs('do-fund-cancel-request-to-join', fid, lid);
  }
  leagueInviteFund(lid: number | string, fid: number | string) {
    return this.#negs('do-league-invite-fund', fid, lid);
  }
  leagueJoinFund(lid: number | string, fid: number | string) {
    return this.#negs('do-league-join-fund', fid, lid);
  }
  leagueRejectFund(lid: number | string, fid: number | string) {
    return this.#negs('do-league-reject-fund', fid, lid);
  }
  leagueResetDecision(lid: number | string, fid: number | string) {
    return this.#negs('do-league-reset-decision', fid, lid);
  }
  fundNegotiateDecision(lid: number | string, fid: number | string, accept: boolean) {
    return this.post('FantasyFunds/FundNegotiateDecision', {
      leagueId: Number(lid),
      fundId: Number(fid),
      accept,
    });
  }
  leagueNegotiateDecision(lid: number | string, fid: number | string, accept: boolean) {
    return this.post('FantasyFunds/LeagueNegotiateDecision', {
      leagueId: Number(lid),
      fundId: Number(fid),
      accept,
    });
  }
}
