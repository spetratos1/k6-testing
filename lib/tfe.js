// lib/tfe.js
// Minimal TFE JSON:API client for k6. This is the "enhancement surface" the
// harness needs; reconcile method names with your existing JS tfe-client and
// delete whatever already exists there. All calls go over HTTPS to the TFE API
// from OUTSIDE the cluster.
//
// Rate limit (corrected per v2 review): TFE allows 30 requests/second per user
// or IP (admin-configurable, never below 30); some sensitive/heavy endpoints are
// lower. There is NO documented 30/min list cap. One jump host + one token share
// one bucket, so treat any 429 as stage-invalidating (counted via api429).

import http from 'k6/http';
import { sleep } from 'k6';
import { api429 } from './metrics.js';

const JSONAPI = 'application/vnd.api+json';

export class TFEClient {
  constructor({ address, token, tokenEnv, adminToken, adminTokenEnv, maxRetries } = {}) {
    this.address = String(address || __ENV.TFE_ADDRESS || '').replace(/\/+$/, '');
    // Token comes from the env var named in the scenario (tfe.token_env, default
    // TFE_TOKEN); never from the scenario file itself.
    this.token = token || __ENV[tokenEnv || 'TFE_TOKEN'] || __ENV.TFE_TOKEN;
    // Optional separate admin token for the observer's Admin Runs calls.
    this.adminToken = adminToken || (adminTokenEnv ? __ENV[adminTokenEnv] : null);
    this.maxRetries = maxRetries == null ? 5 : maxRetries;
  }

  _headers(extra) {
    return Object.assign(
      { Authorization: `Bearer ${this.token}`, 'Content-Type': JSONAPI },
      extra || {},
    );
  }

  // Request with backoff on 429 and 5xx. Returns the final k6 response.
  _req(method, path, body, params) {
    const url = String(path).startsWith('http') ? path : `${this.address}${path}`;
    const p = Object.assign({}, params || {});
    p.headers = this._headers((params || {}).headers);
    if (params && params.token) p.headers.Authorization = `Bearer ${params.token}`; // auth override
    let attempt = 0;
    for (;;) {
      const res = http.request(method, url, body, p);
      if (res.status === 429) api429.add(1);
      const retryable = res.status === 429 || (res.status >= 500 && res.status <= 599);
      if (retryable && attempt < this.maxRetries) {
        attempt += 1;
        const ra = Number(res.headers['Retry-After']);
        sleep(Number.isFinite(ra) && ra > 0 ? ra : Math.min(2 ** attempt, 30));
        continue;
      }
      return res;
    }
  }

  _json(res) {
    try { return JSON.parse(res.body); } catch (_) { return null; }
  }

  // ---------------- Workspaces ----------------
  createWorkspace(org, name, { executionMode = 'remote', autoApply = true } = {}) {
    const body = JSON.stringify({ data: { type: 'workspaces', attributes: {
      name, 'execution-mode': executionMode, 'auto-apply': autoApply,
    } } });
    const res = this._req('POST', `/api/v2/organizations/${org}/workspaces`, body);
    const j = this._json(res);
    if (res.status !== 201 || !j) {
      throw new Error(`createWorkspace ${name}: ${res.status} ${String(res.body).slice(0, 300)}`);
    }
    return j.data; // { id, attributes }
  }

  // Force-delete (removes the workspace even if it has state/resources). NOTE:
  // DELETE /workspaces/:id is the FORCE delete; safe-delete (a separate action)
  // returns 409 if the workspace manages resources. By default only org owners
  // may force-delete unless the org allows workspace admins — use a token that can.
  deleteWorkspace(wsId) {
    const res = this._req('DELETE', `/api/v2/workspaces/${wsId}`);
    return res.status === 204 || res.status === 404;
  }

  // Workspaces whose name starts with prefix (server-side search + client filter).
  listWorkspacesByPrefix(org, prefix) {
    const out = [];
    let page = 1;
    for (;;) {
      const qs = `page%5Bnumber%5D=${page}&page%5Bsize%5D=100`
        + `&search%5Bname%5D=${encodeURIComponent(prefix)}`;
      const res = this._req('GET', `/api/v2/organizations/${org}/workspaces?${qs}`);
      const j = this._json(res);
      if (!j || !j.data) break;
      for (const w of j.data) {
        if (String(w.attributes.name || '').startsWith(prefix)) out.push(w);
      }
      const tp = j.meta && j.meta.pagination && j.meta.pagination['total-pages'];
      if (!tp || page >= tp) break;
      page += 1;
    }
    return out;
  }

  // ---------------- Configuration versions ----------------
  createConfigurationVersion(wsId, { autoQueueRuns = false } = {}) {
    // auto-queue-runs:false so the run ID + start moment belong to the test
    // (default is true, which would queue a run on upload). speculative:false so
    // this is a real plan+apply run, not plan-only.
    const body = JSON.stringify({ data: { type: 'configuration-versions', attributes: {
      'auto-queue-runs': autoQueueRuns,
      speculative: false,
    } } });
    const res = this._req('POST', `/api/v2/workspaces/${wsId}/configuration-versions`, body);
    const j = this._json(res);
    if (res.status !== 201 || !j) {
      throw new Error(`createConfigurationVersion ws=${wsId}: ${res.status} ${String(res.body).slice(0, 300)}`);
    }
    return { id: j.data.id, uploadURL: j.data.attributes['upload-url'] };
  }

  // tarball: ArrayBuffer from open(path, 'b'). Upload URL is a presigned PUT.
  uploadConfiguration(uploadURL, tarball) {
    const res = http.put(uploadURL, tarball, {
      headers: { 'Content-Type': 'application/octet-stream' },
    });
    if (![200, 201, 204].includes(res.status)) {
      throw new Error(`uploadConfiguration: ${res.status} ${String(res.body).slice(0, 300)}`);
    }
    return true;
  }

  // ---------------- Runs ----------------
  createRun(wsId, cvId, { message = 'k6 capacity test', variables = null } = {}) {
    const attributes = { message };
    // Optional per-run Terraform variables, so a scenario can tune the workload
    // (e.g. mock_count, hold_seconds) without rebuilding the tarball.
    if (variables && variables.length) attributes.variables = variables; // [{key, value}]
    const body = JSON.stringify({ data: {
      type: 'runs',
      attributes,
      relationships: {
        workspace: { data: { type: 'workspaces', id: wsId } },
        'configuration-version': { data: { type: 'configuration-versions', id: cvId } },
      },
    } });
    const res = this._req('POST', '/api/v2/runs', body);
    const j = this._json(res);
    if (res.status !== 201 || !j) {
      throw new Error(`createRun ws=${wsId}: ${res.status} ${String(res.body).slice(0, 300)}`);
    }
    return j.data; // attributes.status, attributes['status-timestamps']
  }

  readRun(runId) {
    const res = this._req('GET', `/api/v2/runs/${runId}`);
    const j = this._json(res);
    if (res.status !== 200 || !j) throw new Error(`readRun ${runId}: ${res.status}`);
    return j.data;
  }

  applyRun(runId, comment = 'k6 auto-apply') {
    const res = this._req('POST', `/api/v2/runs/${runId}/actions/apply`, JSON.stringify({ comment }));
    return [200, 202].includes(res.status);
  }

  cancelRun(runId, comment = 'k6 cleanup') {
    const res = this._req('POST', `/api/v2/runs/${runId}/actions/cancel`, JSON.stringify({ comment }));
    return [200, 202, 409].includes(res.status);
  }

  // ---------------- Observation ----------------
  // Runs in a workspace matching any of the given statuses.
  listWorkspaceRunsByStatus(wsId, statuses) {
    const f = encodeURIComponent(statuses.join(','));
    const res = this._req('GET', `/api/v2/workspaces/${wsId}/runs?filter%5Bstatus%5D=${f}&page%5Bsize%5D=100`);
    const j = this._json(res);
    return (j && j.data) || [];
  }

  // Cluster-wide count of runs in the given statuses, via the Admin Runs API.
  // Requires an admin token. Returns -1 if unavailable (caller treats as "skip").
  adminCountRunsByStatus(statuses) {
    const f = encodeURIComponent(statuses.join(','));
    const res = this._req('GET', `/api/v2/admin/runs?filter%5Bstatus%5D=${f}&page%5Bsize%5D=1`,
      null, { token: this.adminToken || this.token });
    if (res.status === 401 || res.status === 403 || res.status === 404) return -1;
    const j = this._json(res);
    const total = j && j.meta && j.meta.pagination && j.meta.pagination['total-count'];
    if (Number.isFinite(total)) return total;
    return j && j.data ? j.data.length : -1;
  }
}
