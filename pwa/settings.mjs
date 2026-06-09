// Settings 视图模块(2026-06-09 从 app.js 抽出第三块)。
// #settings / #settings/<section>:providers 增删改测、role-models 配置、subagents 管理。
// 依赖:core(基础件 + render-bus 转发 render/refreshAll)+ app.js 的
// _bindSidebarNavHandlers(共享侧栏 nav 绑定 —— app↔settings 运行时循环,只在
// 函数体内调用,模块 init 期不碰,ESM 安全)。
import { $, esc, api, showToast, showError, clearError, lastData, requestRender as render, requestRefresh as refreshAll } from './core.mjs';
import { _bindSidebarNavHandlers } from './app.js';

// ---------- Settings views (#settings / #settings/providers) ----------
// 配置可视化第一弹:providers.json 可以在 PWA 里加 / 改 / 删 / 测连通性,
// 不用 ssh。secrets.toml / workspaces.json 是后续子项,目前 Settings hub
// 里显示成 disabled placeholder。

// desktop 统一侧栏:Settings 路由下把 3 个 section 链填进 #sidebar-ctx,跟
// Workspaces 的 repo 树占同一槽位(spec §14 阶段 2)。复用 .shell-nav-item
// 视觉,但 **不带 data-tile-id** —— 否则 _bindSidebarNavHandlers 的
// `.shell-nav-item[data-tile-id]` 选择器会误命中。纯 <a href> 靠 hashchange
// → render() 跳转,不绑自定义 handler;active section 加 .is-active。
// 收起态(.sidebar.is-rail)由 CSS 把整块 .settings-sidebar-nav 隐掉。
function renderSettingsSidebarNav(activeSection) {
  const ctx = $('sidebar-ctx');
  if (!ctx) return;
  const sections = [
    { id: 'providers', label: 'Providers' },
    { id: 'roles', label: 'Roles' },
    { id: 'agents', label: 'Agents' },
  ];
  const links = sections.map((s) => {
    const cls = 'shell-nav-item shell-nav-repo'
      + (s.id === activeSection ? ' is-active' : '');
    return `<a class="${cls}" href="#settings/${s.id}">`
      + `<span class="shell-nav-label">${esc(s.label)}</span></a>`;
  }).join('');
  ctx.innerHTML = `<div class="settings-sidebar-nav">${links}</div>`;
}

function renderSettingsView() {
  // desktop:#settings 无 section → 默认渲 providers 内容(sidebar nav 由
  // render() 填,active=providers)。**不 replaceState**,hash 留 #settings,
  // 让 Settings tab 的"裸 hash"稳定指向默认子页。mobile 保持 hub 卡片。
  if (!window.matchMedia('(max-width: 768px)').matches) {
    renderSettingsProvidersView();
    return;
  }
  const view = $('view');
  view.innerHTML = `
    <h2 style="margin:0 0 var(--space-3)">Settings</h2>
    <div class="settings-hub">
      <a class="settings-card" href="#search">
        <div class="settings-card-title"><strong>Search history</strong> 🔍</div>
        <div class="muted">全文搜索历史 run 的 prompt 和 claude reply(找回上次跟 claude 讨论过的某事)</div>
      </a>
      <a class="settings-card" href="#settings/providers">
        <div class="settings-card-title"><strong>Providers</strong></div>
        <div class="muted">LLM 服务商配置:API key / base URL / model;加 / 改 / 删 / 测连通性</div>
      </a>
      <a class="settings-card" href="#settings/agents">
        <div class="settings-card-title"><strong>Subagents</strong></div>
        <div class="muted">管理 <code>~/.claude/agents/</code> 下的 Claude Code 子代理(code-dev / code-review / 你自己加的)</div>
      </a>
      <div class="settings-card is-disabled">
        <div class="settings-card-title"><strong>Secrets</strong> <span class="tag">soon</span></div>
        <div class="muted">登录用户名/密码 / 飞书 token。目前要 ssh 改 <code>~/.cc-workflow/secrets.toml</code></div>
      </div>
      <div class="settings-card is-disabled">
        <div class="settings-card-title"><strong>Workspaces</strong> <span class="tag">partial</span></div>
        <div class="muted">每 workspace 的 trust / provider 已能在 workspace 详情页 ⚙ 改。完整管理(批量 / engine 切换)待后续</div>
      </div>
    </div>
  `;
}

function renderSettingsSectionView(section) {
  if (section === 'providers') return renderSettingsProvidersView();
  if (section === 'roles') return renderSettingsRolesView();   // 角色默认 model 配置
  if (section === 'agents') return renderSettingsAgentsView();
  // 未知 section → 退回 hub(避免白屏)
  window.history.replaceState(null, '', '#settings');
  renderSettingsView();
}

function renderSettingsProvidersView() {
  const view = $('view');
  const list = lastData.providers || [];
  const rows = list.map(_settingsProviderRow).join('');
  view.innerHTML = `
    <p style="margin:0 0 var(--space-2)"><a href="#settings" class="back-link settings-back-link">← Settings</a></p>
    <div class="ws-toolbar">
      <button class="ws-new-btn" type="button" id="provider-new-btn">+ New provider</button>
    </div>
    ${list.length
      ? `<div class="providers-list">${rows}</div>`
      : '<p class="muted">还没有 provider。点 + New provider 加一个(deepseek / kimi / claude 等)。</p>'}

    <dialog class="ws-new-dialog" id="provider-dialog">
      <form class="ws-new-form" id="provider-form">
        <h3 id="provider-dialog-title">New provider</h3>
        <input type="hidden" name="original_name" value="">
        <label>name <input name="name" pattern="[A-Za-z0-9._\\-]+" required placeholder="deepseek"></label>
        <label>base URL <input name="base_url" type="url" required placeholder="https://api.deepseek.com/anthropic"></label>
        <label>model <input name="model" required placeholder="deepseek-chat"></label>
        <label>API key
          <input name="api_key" type="password" autocomplete="off" placeholder="sk-...">
          <span class="muted" style="font-size:11px" id="api-key-hint">必填</span>
        </label>
        <p class="muted" style="font-size:11px;margin:0">
          保存到 <code>~/.cc-workflow/providers.json</code>。改完立即生效(后端每次调用都从 json 读),不用 restart cc-workflow。
        </p>
        <div class="ws-new-actions">
          <button type="button" class="ws-new-cancel">Cancel</button>
          <button type="submit">Save</button>
        </div>
      </form>
    </dialog>
  `;
  view.querySelector('#provider-new-btn')?.addEventListener('click', _onProviderNewClick);
  view.querySelector('.ws-new-cancel')?.addEventListener('click', _onProviderCancel);
  view.querySelector('#provider-form')?.addEventListener('submit', _onProviderFormSubmit);
  for (const btn of view.querySelectorAll('.provider-edit-btn')) btn.addEventListener('click', _onProviderEditClick);
  for (const btn of view.querySelectorAll('.provider-delete-btn:not([disabled])')) btn.addEventListener('click', _onProviderDeleteClick);
  for (const btn of view.querySelectorAll('.provider-test-btn')) btn.addEventListener('click', _onProviderTestClick);
}

async function renderSettingsRolesView() {
  const view = $('view');
  view.innerHTML = `
    <p style="margin:0 0 var(--space-2)"><a href="#settings" class="back-link settings-back-link">← Settings</a></p>
    <h3 style="margin:0 0 var(--space-2)">Roundtable Roles</h3>
    <p class="muted" style="margin:0 0 var(--space-3)">配每个角色默认用哪个 model。新建 round 表单的 per-role 下拉仍可临时 override 这里的默认。</p>
    <div id="roles-table" class="muted">加载中...</div>`;

  let data;
  try {
    data = await api('/roundtables/models');
  } catch (err) {
    $('roles-table').innerHTML = `<p class="muted">加载失败: ${esc(err.message)}</p>`;
    return;
  }

  const allModels = data.models || [];
  const allRoles = data.roles || [];

  // Vertical stacked cards;model picker 复用 .rt-role-picker /
  // .ws-menu-radio / .ws-radio-dot 风格(跟新建 roundtable 表单一致)。
  // 仅样式复用 — state 模型不同(rt 那边用 localStorage,这里用 DOM
  // is-selected 状态收集到 save 时统一提交)。
  const rows = allRoles.map(role => {
    return `
      <div class="role-config-row" data-role="${esc(role.name)}" data-default-model="${esc(role.default_model)}"
           style="margin-bottom:var(--space-3);padding:var(--space-2);border:1px solid var(--c-border, #333);border-radius:6px">
        <div style="display:flex;align-items:center;gap:var(--space-2);margin-bottom:6px">
          <strong>${esc(role.name)}</strong>
          <span class="muted" style="font-size:11px">(${esc(role.kind)})</span>
        </div>
        ${_renderSettingsRoleModelPicker(role, allModels)}
        <details class="role-prompt-toggle" style="margin-top:8px">
          <summary class="muted" style="font-size:11px;cursor:pointer;user-select:none">
            自定义 system_prompt(可选,清空 = 用默认)
          </summary>
          <textarea data-role-prompt="${esc(role.name)}" class="role-prompt-textarea"
                    rows="8"
                    style="width:100%;font-family:monospace;font-size:12px;margin-top:6px;box-sizing:border-box;resize:vertical"
                    placeholder="留空使用 roles.py 的默认 prompt">${esc(role.default_system_prompt || '')}</textarea>
          <button type="button" class="role-prompt-reset ws-new-btn" data-role="${esc(role.name)}"
                  style="margin-top:6px;background:transparent;color:var(--c-fg);font-size:12px">重置为默认(清空 textarea)</button>
        </details>
      </div>`;
  }).join('');

  $('roles-table').innerHTML = `
    <div>${rows}</div>
    <div style="margin-top:var(--space-3);display:flex;gap:var(--space-2);flex-wrap:wrap">
      <button class="ws-new-btn" id="roles-save-btn" type="button">保存</button>
      <button class="ws-new-btn" id="roles-reset-btn" type="button" style="background:transparent;color:var(--c-fg)">全部重置(回 hardcode)</button>
    </div>`;

  // Bind radio click(picker 内部 model 选择,仅更新 DOM 状态,save 时收集)
  for (const btn of document.querySelectorAll('.settings-role-radio')) {
    btn.addEventListener('click', _onSettingsRoleRadioClick);
  }

  $('roles-save-btn').addEventListener('click', _onRolesSave);
  $('roles-reset-btn').addEventListener('click', _onRolesReset);
  for (const btn of document.querySelectorAll('.role-prompt-reset')) {
    btn.addEventListener('click', _onRolePromptReset);
  }
}

// Settings 页的 model picker — 复用 .rt-role-picker / .ws-menu-radio
// 跟新建 roundtable 表单同一视觉语言。state 走 DOM is-selected,
// 不写 localStorage(那是 rt form 的本地草稿);save 时统一从 DOM 收集
// 提交给 backend。radio list 上限 50vh 避免 model 列表过长撑页面。
function _renderSettingsRoleModelPicker(role, models) {
  const current = role.default_model;
  const currentEndpoint = (models.find((m) => m.name === current) || {}).endpoint || '';
  const kindHint = role.kind === 'synthesizer' ? '<span class="muted rt-role-kind">(整理员)</span>'
                  : role.kind === 'reviewer' ? '<span class="muted rt-role-kind">(审查员)</span>'
                  : role.kind === 'proponent' ? '<span class="muted rt-role-kind">(1v1 对抗)</span>'
                  : role.kind === 'decider' ? '<span class="muted rt-role-kind">(决断员 · opt-in)</span>'
                  : '';
  const radios = models.map((m) => {
    const selected = m.name === current;
    const rowClass = selected ? 'ws-menu-radio settings-role-radio is-selected' : 'ws-menu-radio settings-role-radio';
    const dotClass = selected ? 'ws-radio-dot is-selected' : 'ws-radio-dot';
    return `
      <button type="button" class="${rowClass}"
              data-settings-role="${esc(role.name)}"
              data-value="${esc(m.name)}"
              data-endpoint="${esc(m.endpoint)}">
        <span class="${dotClass}"></span>
        <span class="ws-radio-label">${esc(m.name)}  ·  ${esc(m.endpoint)}</span>
      </button>`;
  }).join('');
  return `
    <details class="rt-role-picker">
      <summary class="rt-role-summary">
        <span class="rt-role-name">${esc(role.name)} ${kindHint}</span>
        <span class="rt-role-current">${esc(current)} · ${esc(currentEndpoint)}</span>
      </summary>
      <div class="rt-role-radio-list" style="max-height:50vh;overflow-y:auto">${radios}</div>
    </details>`;
}

function _onSettingsRoleRadioClick(e) {
  const btn = e.currentTarget;
  const val = btn.dataset.value;
  const endpoint = btn.dataset.endpoint || '';
  const picker = btn.closest('.rt-role-picker');
  if (!picker) return;
  // 仅在该 picker 内换 is-selected — 不影响别的 role 的 picker。
  for (const b of picker.querySelectorAll('.settings-role-radio.is-selected')) {
    b.classList.remove('is-selected');
    b.querySelector('.ws-radio-dot')?.classList.remove('is-selected');
  }
  btn.classList.add('is-selected');
  btn.querySelector('.ws-radio-dot')?.classList.add('is-selected');
  // 更新 summary 显示
  const summary = picker.querySelector('.rt-role-current');
  if (summary) summary.textContent = `${val} · ${endpoint}`;
  // 收起 details(跟 rt form 同行为)
  picker.open = false;
}

async function _onRolesSave(e) {
  const btn = e.currentTarget;
  btn.disabled = true; btn.textContent = '保存中...';

  // 收集 nested {role: {model?, system_prompt?}} — model 从每行 picker
  // 的 .settings-role-radio.is-selected 拿;prompt 从该行 textarea 拿。
  const role_models = {};
  for (const row of document.querySelectorAll('.role-config-row')) {
    const role = row.dataset.role;
    if (!role) continue;
    const selected = row.querySelector('.settings-role-radio.is-selected');
    if (selected) {
      role_models[role] = { model: selected.dataset.value };
    }
    const ta = row.querySelector('textarea[data-role-prompt]');
    if (ta) {
      const prompt = ta.value.trim();
      if (prompt) {
        if (!role_models[role]) role_models[role] = {};
        role_models[role].system_prompt = prompt;
      }
    }
    // 空 prompt 不加字段 → backend 看到只有 model 没 prompt → 清掉 prompt override
  }

  try {
    await api('/settings/role-models', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role_models }),
    });
    showToast('success', 'role overrides 已保存', { ttl: 2500 });
    // 保存成功后重新 fetch — backend 可能 normalize 值(strip 空白等),
    // 不刷新页面值会跟存盘值不一致。跟 _onRolesReset 对称(I-1 修)。
    renderSettingsRolesView();
  } catch (err) {
    showError(`保存失败: ${err.message}`);
  } finally {
    btn.disabled = false; btn.textContent = '保存';
  }
}

async function _onRolesReset(e) {
  if (!confirm('清空所有 role override,所有角色回到 hardcode 默认?')) return;
  const btn = e.currentTarget;
  btn.disabled = true; btn.textContent = '清空中...';
  try {
    await api('/settings/role-models', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role_models: {} }),
    });
    showToast('success', '已清空所有 override', { ttl: 2500 });
    renderSettingsRolesView();    // 刷新当前页
  } catch (err) {
    showError(`清空失败: ${err.message}`);
  } finally {
    btn.disabled = false; btn.textContent = '全部重置(回 hardcode)';
  }
}

function _onRolePromptReset(e) {
  const role = e.currentTarget.dataset.role;
  const ta = document.querySelector(`textarea[data-role-prompt="${CSS.escape(role)}"]`);
  if (ta) { ta.value = ''; ta.focus(); }
  // 不立即调 API — 用户得点"保存"才真正提交。给个 toast 提示。
  showToast('info', `${role} prompt 已清空 — 点保存才真正回默认`, { ttl: 2500 });
}

// ---- #settings/agents — Claude Code subagent CRUD ---- //

async function renderSettingsAgentsView() {
  const view = $('view');
  view.innerHTML = `
    <p style="margin:0 0 var(--space-2)"><a href="#settings" class="back-link settings-back-link">← Settings</a></p>
    <h3 style="margin:0 0 var(--space-2)">Subagents</h3>
    <p class="muted" style="margin:0 0 var(--space-3)">
      管理 user-global subagents(<code>~/.claude/agents/*.md</code>)。改完 Claude Code 立刻生效,无需重启 backend。
    </p>
    <div style="display:flex;gap:var(--space-2);margin-bottom:var(--space-3);flex-wrap:wrap">
      <button class="ws-new-btn" id="agent-new-btn" type="button">+ New agent</button>
    </div>
    <div id="agents-list" class="muted">加载中...</div>`;

  let agents;
  try {
    agents = await api('/agents');
  } catch (err) {
    $('agents-list').innerHTML = `<p class="muted">加载失败: ${esc(err.message)}</p>`;
    return;
  }

  if (agents.length === 0) {
    $('agents-list').innerHTML = `<p class="muted">还没有 subagent。点 "+ New agent" 加一个,或 ssh 在 ~/.claude/agents/ 手编。</p>`;
  } else {
    $('agents-list').innerHTML = agents.map((a) => _renderAgentCard(a, false)).join('');
  }

  // Bind events
  $('agent-new-btn').addEventListener('click', _onAgentNewClick);
  for (const btn of document.querySelectorAll('.agent-save-btn')) {
    btn.addEventListener('click', _onAgentSave);
  }
  for (const btn of document.querySelectorAll('.agent-delete-btn')) {
    btn.addEventListener('click', _onAgentDelete);
  }
}

function _renderAgentCard(agent, isNew) {
  const nameHtml = isNew
    ? `<input data-agent-field="name" placeholder="新 agent 名(小写字母/数字/-)" pattern="[a-z0-9][a-z0-9-]*" required style="font-weight:bold;font-size:14px;padding:4px 6px">`
    : `<strong>${esc(agent.name)}</strong>`;
  const summaryDesc = isNew
    ? '<span class="muted">(新建)</span>'
    : `<span class="muted" style="font-size:12px;margin-left:8px">${esc(agent.description || '(no description)')}</span>`;
  const deleteBtn = isNew
    ? ''
    : `<button class="ws-new-btn agent-delete-btn" data-name="${esc(agent.name)}" type="button" style="background:transparent;color:var(--c-fg)">删除</button>`;
  return `
    <div class="agent-card" data-name="${esc(agent.name)}" data-is-new="${isNew ? '1' : '0'}"
         style="margin-bottom:var(--space-3);padding:var(--space-2);border:1px solid var(--c-border, #333);border-radius:6px">
      <details ${isNew ? 'open' : ''}>
        <summary style="cursor:pointer;user-select:none;list-style:none">
          ${nameHtml}
          ${summaryDesc}
        </summary>
        <div style="margin-top:var(--space-2);display:flex;flex-direction:column;gap:var(--space-2)">
          <label style="display:block">
            <div class="muted" style="font-size:11px;margin-bottom:2px">description(main agent 看这个决定要不要 dispatch)</div>
            <textarea data-agent-field="description" rows="3"
                      style="width:100%;font-size:12px;box-sizing:border-box;resize:vertical">${esc(agent.description || '')}</textarea>
          </label>
          <label style="display:block">
            <div class="muted" style="font-size:11px;margin-bottom:2px">tools(逗号分隔 — Read, Edit, Bash, Glob, Grep, WebFetch, Skill 等)</div>
            <input data-agent-field="tools" type="text"
                   style="width:100%;font-family:monospace;font-size:12px;box-sizing:border-box;padding:4px 6px"
                   value="${esc((agent.tools || []).join(', '))}">
          </label>
          <label style="display:block">
            <div class="muted" style="font-size:11px;margin-bottom:2px">system_prompt(markdown)</div>
            <textarea data-agent-field="system_prompt" rows="20"
                      style="width:100%;font-family:monospace;font-size:12px;box-sizing:border-box;resize:vertical">${esc(agent.system_prompt || '')}</textarea>
          </label>
          <div style="display:flex;gap:var(--space-2);flex-wrap:wrap">
            <button class="ws-new-btn agent-save-btn" data-name="${esc(agent.name)}" type="button">保存</button>
            ${deleteBtn}
          </div>
        </div>
      </details>
    </div>`;
}

function _onAgentNewClick() {
  const list = $('agents-list');
  // 如果 list 当前显示的是"还没有 subagent..." 文案(没有 .agent-card),先清空
  if (list.querySelector('.agent-card') === null) {
    list.innerHTML = '';
  }
  const emptyAgent = { name: '', description: '', tools: [], system_prompt: '' };
  list.insertAdjacentHTML('afterbegin', _renderAgentCard(emptyAgent, true));
  const newCard = list.querySelector('.agent-card[data-is-new="1"]');
  newCard.querySelector('input[data-agent-field="name"]')?.focus();
  // 重新 bind 这张新卡的 save handler(新建卡没有 delete 按钮)
  newCard.querySelector('.agent-save-btn')?.addEventListener('click', _onAgentSave);
}

async function _onAgentSave(e) {
  const btn = e.currentTarget;
  const card = btn.closest('.agent-card');
  if (!card) return;
  const isNew = card.dataset.isNew === '1';
  let name;
  if (isNew) {
    const nameInput = card.querySelector('input[data-agent-field="name"]');
    name = (nameInput?.value || '').trim();
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) {
      showError('agent name 必须匹配 [a-z0-9][a-z0-9-]* 且 ≤64 字');
      nameInput?.focus();
      return;
    }
  } else {
    name = btn.dataset.name;
  }

  const desc = card.querySelector('textarea[data-agent-field="description"]').value;
  const toolsRaw = card.querySelector('input[data-agent-field="tools"]').value;
  const tools = toolsRaw.split(',').map((s) => s.trim()).filter(Boolean);
  const promptText = card.querySelector('textarea[data-agent-field="system_prompt"]').value;

  btn.disabled = true; btn.textContent = '保存中...';
  try {
    await api(`/agents/${encodeURIComponent(name)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        description: desc, tools, system_prompt: promptText,
      }),
    });
    showToast('success', `agent "${name}" 已保存`, { ttl: 2500 });
    renderSettingsAgentsView();
  } catch (err) {
    showError(`保存失败: ${err.message}`);
  } finally {
    btn.disabled = false; btn.textContent = '保存';
  }
}

async function _onAgentDelete(e) {
  const btn = e.currentTarget;
  const name = btn.dataset.name;
  if (!confirm(`确定删除 subagent "${name}"?\n\n这会删 ~/.claude/agents/${name}.md 文件,Claude Code 之后不再认识这个 agent。`)) {
    return;
  }
  btn.disabled = true; btn.textContent = '删除中...';
  try {
    await api(`/agents/${encodeURIComponent(name)}`, { method: 'DELETE' });
    showToast('success', `agent "${name}" 已删除`, { ttl: 2500 });
    renderSettingsAgentsView();
  } catch (err) {
    showError(`删除失败: ${err.message}`);
  } finally {
    btn.disabled = false; btn.textContent = '删除';
  }
}

function _settingsProviderRow(p) {
  const dDis = p.is_default ? 'disabled title="default 不能删,先改 config.toml#provider"' : '';
  return `
    <div class="provider-row${p.is_default ? ' is-default' : ''}" data-name="${esc(p.name)}">
      <div class="provider-row-head">
        <strong>${esc(p.name)}</strong>
        ${p.is_default ? '<span class="tag">default</span>' : ''}
      </div>
      <div class="provider-row-body">
        <div class="provider-field"><span class="muted">base_url</span><code>${esc(p.base_url || '—')}</code></div>
        <div class="provider-field"><span class="muted">model</span><code>${esc(p.model || '—')}</code></div>
        <div class="provider-field"><span class="muted">key</span><code>${esc(p.key_masked || '—')}</code></div>
      </div>
      <div class="provider-row-actions">
        <button class="provider-test-btn" type="button" data-name="${esc(p.name)}">Test</button>
        <button class="provider-edit-btn" type="button" data-name="${esc(p.name)}">Edit</button>
        <button class="provider-delete-btn" type="button" data-name="${esc(p.name)}" ${dDis}>Delete</button>
      </div>
    </div>
  `;
}

function _onProviderNewClick() {
  const dlg = document.getElementById('provider-dialog');
  const form = dlg.querySelector('form');
  form.reset();
  form.elements.original_name.value = '';
  document.getElementById('provider-dialog-title').textContent = 'New provider';
  document.getElementById('api-key-hint').textContent = '必填';
  dlg.showModal();
}

function _onProviderEditClick(e) {
  const name = e.currentTarget.dataset.name;
  const p = (lastData.providers || []).find((x) => x.name === name);
  if (!p) return;
  const dlg = document.getElementById('provider-dialog');
  const form = dlg.querySelector('form');
  form.reset();
  form.elements.original_name.value = name;
  form.elements.name.value = name;
  form.elements.base_url.value = p.base_url || '';
  form.elements.model.value = p.model || '';
  form.elements.api_key.value = '';
  document.getElementById('provider-dialog-title').textContent = `Edit ${name}`;
  document.getElementById('api-key-hint').textContent = `留空 = 不改(当前: ${p.key_masked || '(none)'})`;
  dlg.showModal();
}

function _onProviderCancel() {
  document.getElementById('provider-dialog')?.close();
}

async function _onProviderFormSubmit(e) {
  e.preventDefault();
  const form = e.target;
  const original = form.elements.original_name.value;
  const isEdit = !!original;
  const fd = Object.fromEntries(new FormData(form).entries());
  if (isEdit && original !== fd.name) {
    showError(`不能改 name(${original} → ${fd.name});先 Delete 再 New 一个新的`);
    return;
  }
  const body = {
    name: fd.name,
    base_url: fd.base_url,
    model: fd.model,
    api_key: fd.api_key,
  };
  const btn = form.querySelector('button[type="submit"]');
  btn.disabled = true;
  const orig = btn.textContent;
  btn.textContent = 'Saving…';
  try {
    if (isEdit) {
      await api(`/providers/${encodeURIComponent(original)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } else {
      await api('/providers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    }
    document.getElementById('provider-dialog').close();
    showToast('success', isEdit ? `Provider ${fd.name} 已更新` : `Provider ${fd.name} 已添加`);
    await refreshAll();
    renderSettingsProvidersView();
  } catch (err) {
    showError(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = orig;
  }
}

async function _onProviderDeleteClick(e) {
  const name = e.currentTarget.dataset.name;
  if (!confirm(`删除 provider 「${name}」?\nproviders.json 会被改写,不可撤销。`)) return;
  const btn = e.currentTarget;
  btn.disabled = true;
  btn.textContent = 'Deleting…';
  try {
    await api(`/providers/${encodeURIComponent(name)}`, { method: 'DELETE' });
    showToast('success', `Provider ${name} 已删除`);
    await refreshAll();
    renderSettingsProvidersView();
  } catch (err) {
    showError(err.message);
    btn.disabled = false;
    btn.textContent = 'Delete';
  }
}

async function _onProviderTestClick(e) {
  const name = e.currentTarget.dataset.name;
  const btn = e.currentTarget;
  const orig = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Testing…';
  try {
    const r = await api(`/providers/${encodeURIComponent(name)}/test`, { method: 'POST' });
    showToast('success', `${name}: ${(r.reply || '(empty)').slice(0, 80)}`, { ttl: 4000 });
  } catch (err) {
    showError(err, { prefix: `${name} test` });
  } finally {
    btn.disabled = false;
    btn.textContent = orig;
  }
}

export { renderSettingsSidebarNav, renderSettingsView, renderSettingsSectionView };
