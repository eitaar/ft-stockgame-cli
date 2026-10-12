import { HTTP_BASE, ORIGIN, GAME_URL } from './config.js';

export class ApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

export class Api {
  constructor(token, { onUnauthorized } = {}) {
    this.token = token;
    this.onUnauthorized = onUnauthorized;
  }

  async #call(method, path, { body, raw = false, retry = true } = {}) {
    const headers = { Origin: ORIGIN, Referer: `${GAME_URL}` };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    const init = { method, headers };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const url = path.startsWith('http') ? path : HTTP_BASE + path;
    const res = await fetch(url, init);
    const text = await res.text();
    let json;
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
    return raw ? json : json?.result ?? json;
  }

  get(path, opts) {
    return this.#call('GET', path, opts);
  }

  post(path, body, opts) {
    return this.#call('POST', path, { body, ...opts });
  }

  // ---- identity ----------------------------------------------------------
  userdata() {
    return this.get('fantasyfunds/userdata');
  }

  player(pid) {
    return this.get(`FantasyFunds/PlayerData/${pid}`);
  }

  badges(pid) {
    return this.get(`FantasyFunds/PlayerBadges?playerId=${pid}`);
  }

  searchPlayers(term) {
    return this.get(`FantasyFunds/searchplayerfund?term=${encodeURIComponent(term)}`);
  }

  // ---- universe / market -------------------------------------------------
  async universe() {
    const [overview, traded] = await Promise.all([
      this.get('v1/invest-hubs/overview'),
      this.get('FantasyFunds/GetAllTradedStocks'),
    ]);
    return { overview, traded };
  }

  // ---- leagues -----------------------------------------------------------
  leagues() {
    return this.get('FantasyFunds/GetLeagues');
  }

  officialLeagues() {
    return this.get('official-leagues');
  }

  leaguePage(lid) {
    return this.get(`FantasyFunds/GetLeaguePage?leagueId=${lid}`);
  }

  leagueFunds(lid) {
    return this.get(`FantasyFunds/LeagueFundList?leagueId=${lid}`);
  }

  leagueFundResults(lid) {
    return this.get(`FantasyFunds/leaguefundresultlist?leagueId=${lid}`);
  }

  createLeague(leagueName) {
    return this.post('FantasyFunds/CreateLeague', { leagueName });
  }

  deleteLeague(leagueId) {
    return this.post('FantasyFunds/DeleteLeague', { leagueId: Number(leagueId) });
  }

  leaveLeague(leagueId, fundId) {
    return this.post('FantasyFunds/LeaveLeague', { leagueId: Number(leagueId), fundId: Number(fundId) });
  }

  // ---- funds / picks -----------------------------------------------------
  fundNegotiations(fid) {
    return this.get(`FantasyFunds/GetFundNegotiations?fundId=${fid}`);
  }

  historicalFundPerformance(fid) {
    return this.get(`FantasyFunds/historical-fund-performance?fid=${fid}`);
  }

  /** order is an object mapping eid -> percentage, e.g. { S4: 11, S2: 8 }. */
  reweight(fid, order) {
    return this.post('FantasyFunds/ReweighSelectedFund/', { fundId: Number(fid), order });
  }

  cancelReweight(fid) {
    return this.post('FantasyFunds/CancelReweighSelectedFund', { fundId: Number(fid) });
  }

  createFund(fundName, order) {
    return this.post('FantasyFunds/CreateFund', { fundName, orderMapStr: JSON.stringify(order) });
  }

  registerPlayerWithFund({ playerName, fundName }, order) {
    return this.post('FantasyFunds/RegisterPlayerWithFund', {
      registrationDataStr: JSON.stringify({ playerName, fundName }),
      orderMapStr: JSON.stringify(order),
    });
  }

  deleteSelf() {
    return this.post('FantasyFunds/DeleteSelf', {});
  }

  // ---- social ------------------------------------------------------------
  follow(pid) {
    return this.post('FantasyFunds/Follow', { playerId: Number(pid) });
  }

  unfollow(pid) {
    return this.post('FantasyFunds/Unfollow', { playerId: Number(pid) });
  }

  privateActivity() {
    return this.get('FantasyFunds/PrivateActivity');
  }

  // ---- negotiations (new leagues system) ---------------------------------
  playerMeta() {
    return this.get('FantasyFunds/new-negs/player-meta');
  }

  playerNegotiations() {
    return this.get('FantasyFunds/new-negs/player-negotiations');
  }

  leagueNegotiations(lid) {
    return this.get(`FantasyFunds/new-negs/league-negotiations?lid=${lid}`);
  }

  searchToInvite(lid, term) {
    return this.get(`FantasyFunds/new-negs/league-search-to-invite?lid=${lid}&term=${encodeURIComponent(term)}`);
  }

  #negs(action, fid, lid) {
    return this.post(`FantasyFunds/new-negs/${action}?fid=${fid}&lid=${lid}`);
  }

  fundJoinLeague(fid, lid) {
    return this.#negs('do-fund-join-league', fid, lid);
  }

  fundRequestToJoin(fid, lid) {
    return this.#negs('do-fund-request-to-join-league', fid, lid);
  }

  fundLeaveLeague(fid, lid) {
    return this.#negs('do-fund-leave-league', fid, lid);
  }

  fundRejectInvite(fid, lid) {
    return this.#negs('do-fund-reject-invite', fid, lid);
  }

  fundCancelRequest(fid, lid) {
    return this.#negs('do-fund-cancel-request-to-join', fid, lid);
  }

  leagueInviteFund(lid, fid) {
    return this.#negs('do-league-invite-fund', fid, lid);
  }

  leagueJoinFund(lid, fid) {
    return this.#negs('do-league-join-fund', fid, lid);
  }

  leagueRejectFund(lid, fid) {
    return this.#negs('do-league-reject-fund', fid, lid);
  }

  leagueResetDecision(lid, fid) {
    return this.#negs('do-league-reset-decision', fid, lid);
  }

  fundNegotiateDecision(lid, fid, accept) {
    return this.post('FantasyFunds/FundNegotiateDecision', { leagueId: Number(lid), fundId: Number(fid), accept });
  }

  leagueNegotiateDecision(lid, fid, accept) {
    return this.post('FantasyFunds/LeagueNegotiateDecision', { leagueId: Number(lid), fundId: Number(fid), accept });
  }
}
