/**
 * Native Context Panel frontend.
 * Polls /api/context with ETag caching, syncs live host CSS theme variables,
 * and opens files / subagent conversations via window.sidecar.ui.
 */
(() => {
  const POLL_MS = 1200;
  const $ = (id) => document.getElementById(id);

  const CATEGORIES = [
    { key: 'messages', label: 'Messages', color: 'var(--c-messages)', always: true },
    { key: 'agentResponses', label: 'Agent responses', color: 'var(--c-agent)', expandGroup: 'agent', always: true },
    { key: 'toolCalls', label: 'Tool calls', color: 'var(--c-tools)', expandGroup: 'tools', always: true },
    { key: 'mcpTools', label: 'MCP tools', color: 'var(--c-mcp)', targetSec: 'sec-mcp' },
    { key: 'systemTools', label: 'System tools', color: 'var(--c-sys-tools)', always: true },
    { key: 'systemPrompt', label: 'System prompt', color: 'var(--c-sys-prompt)', always: true },
    { key: 'rulesFiles', label: 'Rules & memory', color: 'var(--c-rules)', targetSec: 'sec-rules' },
    { key: 'skills', label: 'Skills', color: 'var(--c-skills)', targetSec: 'sec-skills' },
    { key: 'mcpInstructions', label: 'MCP server instructions', color: 'var(--c-mcp-inst)', targetSec: 'sec-mcp' },
    { key: 'customAgents', label: 'Custom agents', color: 'var(--c-agents)', targetSec: 'sec-agents' },
    { key: 'systemMessages', label: 'System messages', color: 'var(--c-sys-msg)' },
    { key: 'checkpointBuffer', label: 'Checkpoint buffer', color: 'var(--c-compact)', targetSec: 'sec-growth' },
  ];

  try {
    localStorage.removeItem('context_panel_limit');
  } catch {}

  const state = {
    etag: '',
    snap: null,
    workspaces: [],
    viewMode: localStorage.getItem('context_panel_view') === 'grid' ? 'grid' : 'bar',
    fallbackConvId: new URLSearchParams(location.search).get('conversationId') || '',
    expandedInline: new Set(), // 'agent' | 'tools'
    hoverKey: null,
    timer: null,
  };

  // ---------- Theme Sync ----------
  function syncScheme() {
    const probe = document.createElement('span');
    probe.style.cssText = 'position:absolute;visibility:hidden;color:var(--background, #f7f7f8)';
    document.documentElement.appendChild(probe);
    const c = getComputedStyle(probe).color;
    probe.remove();
    const nums = (c.match(/[\d.]+/g) || []).map(Number);
    if (nums.length < 3) return;
    const scale = c.startsWith('color(') ? 1 : 255;
    const [r, g, b] = nums.slice(0, 3).map((v) => v / scale);
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const theme = lum < 0.5 ? 'dark' : 'light';
    if (document.documentElement.dataset.theme !== theme) {
      document.documentElement.dataset.theme = theme;
    }
  }
  syncScheme();
  new MutationObserver(syncScheme).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['style'],
  });

  // ---------- Helpers ----------
  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }[c]));

  function fmtTok(n) {
    const v = Number(n) || 0;
    if (v >= 1000000) {
      const m = v / 1000000;
      return `${Number.isInteger(m) ? m : m.toFixed(1)}M`;
    }
    if (v >= 1000) return `${(v / 1000).toFixed(1)}k`;
    return String(v);
  }

  function fmtLimit(n) {
    const v = Number(n) || 0;
    if (v === 1048576 || v === 1000000) return '1M';
    if (v === 2097152 || v === 2000000) return '2M';
    if (v === 200000) return '200k';
    if (v === 131072 || v === 128000) return '128k';
    if (v === 65536) return '64k';
    if (v === 32768) return '32k';
    if (v >= 1000000) return `${+(v / 1000000).toFixed(1)}M`;
    if (v >= 1000) return `${Math.round(v / 1000)}k`;
    return String(v);
  }

  function fmtPct(tokens, limit) {
    if (!limit) return '0.0%';
    return `${((tokens / limit) * 100).toFixed(1)}%`;
  }

  const OPEN_ICON =
    '<svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true"><path d="M6.5 3.5H4a1 1 0 0 0-1 1v7.5a1 1 0 0 0 1 1h7.5a1 1 0 0 0 1-1V9.5"/><path d="M9.5 3h3.5v3.5M13 3l-5.5 5.5"/></svg>';

  const INLINE_CHEV =
    '<svg class="row-chev" width="10" height="10" viewBox="0 0 12 12" aria-hidden="true"><path d="M4.25 2.5 7.75 6l-3.5 3.5"/></svg>';

  function openFile(path) {
    const uri = state.snap?.allowedFiles?.[path];
    if (!uri) return;
    window.sidecar?.ui?.toggleAuxPane?.({ tabType: 'fileView', uri });
  }

  function openConversation(convId) {
    if (!convId) return;
    window.sidecar?.ui?.toggleConversation?.(convId);
  }

  function jumpToSection(secId) {
    const el = $(secId);
    if (!el || el.classList.contains('hidden')) return;
    el.open = true;
    el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function hasSectionItems(secId, details) {
    if (!details) return false;
    switch (secId) {
      case 'sec-tools':
        return (details.totalToolCalls || details.heavyToolCalls?.length || 0) > 0;
      case 'sec-mcp':
        return (details.mcpServers?.length || 0) > 0;
      case 'sec-rules':
        return (details.rules?.length || 0) > 0;
      case 'sec-skills':
        return (details.skills?.length || 0) > 0;
      case 'sec-agents':
        return (details.spawnedSubagents?.length || 0) + (details.customAgents?.length || 0) > 0;
      case 'sec-artifacts':
        return (details.artifacts?.length || 0) > 0;
      case 'sec-growth':
        return (details.turnsHistory?.length || 0) > 0;
      default:
        return false;
    }
  }

  // ---------- Two-Way Hover Highlight Sync ----------
  function applyHoverHighlight(key) {
    state.hoverKey = key;
    document.querySelectorAll('.bar-seg, .grid-cell[data-cat]').forEach((el) => {
      if (!key) {
        el.classList.remove('dim', 'hot');
      } else if (el.dataset.cat === key) {
        el.classList.remove('dim');
        el.classList.add('hot');
      } else {
        el.classList.remove('hot');
        el.classList.add('dim');
      }
    });
    document.querySelectorAll('.cat-row[data-cat]').forEach((el) => {
      el.classList.toggle('hot', Boolean(key && el.dataset.cat === key));
    });
  }

  // ---------- Renderers ----------
  function renderVisuals(snap) {
    const limit = snap.contextLimit || 1048576;
    const barDenom = Math.max(limit, snap.usedTokens, 1);
    const activeCats = CATEGORIES.filter((c) => (snap.categories[c.key] || 0) > 0);

    // Bar view
    const bar = $('bar-wrap');
    bar.innerHTML = activeCats
      .map((c) => {
        const val = snap.categories[c.key] || 0;
        const w = Math.max(0.4, (val / barDenom) * 100);
        return `<div class="bar-seg" data-cat="${c.key}" style="width:${w.toFixed(3)}%;background:${c.color}" title="${esc(c.label)}: ${fmtTok(val)} (${fmtPct(val, limit)})"></div>`;
      })
      .join('');

    // Grid view (100 proportional cells = 1% each)
    const grid = $('grid-wrap');
    const totalCells = 100;
    const cells = [];
    for (const c of activeCats) {
      const val = snap.categories[c.key] || 0;
      const count = Math.round((val / barDenom) * totalCells);
      for (let i = 0; i < count && cells.length < totalCells; i++) {
        cells.push(`<span class="grid-cell" data-cat="${c.key}" style="background:${c.color}" title="${esc(c.label)}: ${fmtTok(val)} (${fmtPct(val, limit)})"></span>`);
      }
    }
    while (cells.length < totalCells) {
      cells.push(`<span class="grid-cell free" title="Free space: ${fmtTok(snap.freeTokens)}"></span>`);
    }
    grid.innerHTML = cells.join('');

    const isGrid = state.viewMode === 'grid';
    bar.classList.toggle('hidden', isGrid);
    grid.classList.toggle('hidden', !isGrid);
    $('view-bar-btn').classList.toggle('on', !isGrid);
    $('view-bar-btn').setAttribute('aria-pressed', String(!isGrid));
    $('view-grid-btn').classList.toggle('on', isGrid);
    $('view-grid-btn').setAttribute('aria-pressed', String(isGrid));
  }

  function renderCategoryRows(snap) {
    const limit = snap.contextLimit || 1048576;
    const cats = snap.categories;
    const details = snap.details;

    const activeHtml = [];
    for (const c of CATEGORIES) {
      const val = cats[c.key] || 0;
      if (!c.always && val === 0) continue;

      const isExpand = Boolean(c.expandGroup);
      const isExpanded = isExpand && state.expandedInline.has(c.expandGroup);
      const validTarget = c.targetSec && hasSectionItems(c.targetSec, details) ? c.targetSec : '';
      const clickable = isExpand || Boolean(validTarget);

      const a11yAttrs = clickable
        ? isExpand
          ? ` role="button" tabindex="0" aria-expanded="${isExpanded}"`
          : ` role="button" tabindex="0"`
        : '';

      activeHtml.push(`
        <div class="cat-row${clickable ? ' clickable' : ''}${isExpanded ? ' expanded' : ''}" data-cat="${c.key}"${isExpand ? ` data-expand="${c.expandGroup}"` : ''}${validTarget ? ` data-target="${validTarget}"` : ''}${a11yAttrs}>
          <span class="swatch" style="background:${c.color}"></span>
          <span class="cat-label-wrap">
            <span class="cat-label">${esc(c.label)}</span>
            ${isExpand ? INLINE_CHEV : ''}
          </span>
          <span class="cat-tok num">${fmtTok(val)}</span>
          <span class="cat-pct num">${fmtPct(val, limit)}</span>
        </div>
      `);

      if (c.key === 'agentResponses' && isExpanded) {
        activeHtml.push(`
          <div class="cat-row sub">
            <span class="swatch" style="background:${c.color}"></span>
            <span class="cat-label-wrap"><span class="cat-label">Replies</span></span>
            <span class="cat-tok num">${fmtTok(cats.agentReplies)}</span>
            <span class="cat-pct num">${fmtPct(cats.agentReplies, limit)}</span>
          </div>
          <div class="cat-row sub">
            <span class="swatch" style="background:${c.color}"></span>
            <span class="cat-label-wrap"><span class="cat-label">Thinking / reasoning</span></span>
            <span class="cat-tok num">${fmtTok(cats.agentThinking)}</span>
            <span class="cat-pct num">${fmtPct(cats.agentThinking, limit)}</span>
          </div>
        `);
      }
      if (c.key === 'toolCalls' && isExpanded) {
        activeHtml.push(`
          <div class="cat-row sub">
            <span class="swatch" style="background:${c.color}"></span>
            <span class="cat-label-wrap"><span class="cat-label">Tool outputs</span></span>
            <span class="cat-tok num">${fmtTok(cats.toolCallOutputs)}</span>
            <span class="cat-pct num">${fmtPct(cats.toolCallOutputs, limit)}</span>
          </div>
          <div class="cat-row sub">
            <span class="swatch" style="background:${c.color}"></span>
            <span class="cat-label-wrap"><span class="cat-label">Tool arguments</span></span>
            <span class="cat-tok num">${fmtTok(cats.toolCallArgs)}</span>
            <span class="cat-pct num">${fmtPct(cats.toolCallArgs, limit)}</span>
          </div>
        `);
      }
    }
    $('rows-active').innerHTML = activeHtml.join('');

    $('rows-window').innerHTML = `
      <div class="cat-row muted-row" title="Uncached tokens sent on the latest planner turn">
        <span class="swatch" style="background:var(--c-cache-delta)"></span>
        <span class="cat-label-wrap"><span class="cat-label">Since last cache</span></span>
        <span class="cat-tok num">${fmtTok(cats.sinceLastCache)}</span>
        <span class="cat-pct num">${fmtPct(cats.sinceLastCache, limit)}</span>
      </div>
      <div class="cat-row muted-row">
        <span class="swatch" style="background:var(--c-free)"></span>
        <span class="cat-label-wrap"><span class="cat-label">Free space</span></span>
        <span class="cat-tok num">${fmtTok(snap.freeTokens)}</span>
        <span class="cat-pct num">${fmtPct(snap.freeTokens, limit)}</span>
      </div>
    `;

    const defRows = [];
    if (cats.mcpDeferred > 0) {
      const target = hasSectionItems('sec-mcp', details);
      defRows.push(`
        <div class="cat-row muted-row${target ? ' clickable' : ''}"${target ? ' data-target="sec-mcp" role="button" tabindex="0"' : ''} title="Lazy MCP tool schemas on disk (0 active tokens until read)">
          <span class="swatch" style="background:var(--c-mcp);opacity:0.45"></span>
          <span class="cat-label-wrap"><span class="cat-label">MCP tools (deferred)</span></span>
          <span class="cat-tok num">${fmtTok(cats.mcpDeferred)}</span>
          <span class="cat-pct num"></span>
        </div>
      `);
    }
    if (cats.skillsDeferred > 0) {
      const target = hasSectionItems('sec-skills', details);
      defRows.push(`
        <div class="cat-row muted-row${target ? ' clickable' : ''}"${target ? ' data-target="sec-skills" role="button" tabindex="0"' : ''} title="Unread SKILL.md bodies held on disk via progressive disclosure">
          <span class="swatch" style="background:var(--c-skills);opacity:0.45"></span>
          <span class="cat-label-wrap"><span class="cat-label">Skills (deferred)</span></span>
          <span class="cat-tok num">${fmtTok(cats.skillsDeferred)}</span>
          <span class="cat-pct num"></span>
        </div>
      `);
    }
    if (cats.rulesDeferred > 0) {
      const target = hasSectionItems('sec-rules', details);
      defRows.push(`
        <div class="cat-row muted-row${target ? ' clickable' : ''}"${target ? ' data-target="sec-rules" role="button" tabindex="0"' : ''} title="On-demand rule files not yet triggered">
          <span class="swatch" style="background:var(--c-rules);opacity:0.45"></span>
          <span class="cat-label-wrap"><span class="cat-label">Rules (deferred)</span></span>
          <span class="cat-tok num">${fmtTok(cats.rulesDeferred)}</span>
          <span class="cat-pct num"></span>
        </div>
      `);
    }
    $('deferred-divider').classList.toggle('hidden', defRows.length === 0);
    $('rows-deferred').innerHTML = defRows.join('');
  }

  function renderDetails(snap) {
    const d = snap.details;
    const allowed = snap.allowedFiles || {};
    let visibleSections = 0;

    // 1. Tool calls (heaviest)
    const toolsCount = d.totalToolCalls || d.heavyToolCalls.length;
    $('sec-tools').classList.toggle('hidden', toolsCount === 0);
    if (toolsCount > 0) visibleSections++;
    $('count-tools').textContent = String(toolsCount);
    $('body-tools').innerHTML = d.heavyToolCalls
      .map((t) => {
        const canOpen = t.path && allowed[t.path];
        return `
          <div class="item-row">
            <div class="item-main">
              <span class="item-name" title="${esc(t.label)}">${esc(t.label)}</span>
              <span class="badge">step ${t.stepIndex}</span>
            </div>
            <div class="item-right">
              <span class="item-tok num">${fmtTok(t.tokens)}</span>
              ${canOpen ? `<button type="button" class="open-btn" data-open-file="${esc(t.path)}" title="Open file">${OPEN_ICON}</button>` : ''}
            </div>
          </div>
        `;
      })
      .join('');

    // 2. MCP tools (preserve inner server <details> open states)
    const openServers = new Set(
      [...$('body-mcp').querySelectorAll('details[open]')].map((el) => el.dataset.server)
    );
    $('sec-mcp').classList.toggle('hidden', d.mcpServers.length === 0);
    if (d.mcpServers.length > 0) visibleSections++;
    $('count-mcp').textContent = String(d.totalMcpTools);
    $('body-mcp').innerHTML = d.mcpServers
      .map((srv) => {
        const isOpen = openServers.has(srv.name) ? ' open' : '';
        const statusBadge = srv.disabled
          ? '<span class="badge warn">disabled</span>'
          : `<span class="badge">${srv.toolCount} tools</span>`;
        const toolsHtml = srv.tools
          .map((t) => {
            const canOpen = t.path && allowed[t.path];
            return `
              <div class="item-row">
                <div class="item-main">
                  <span class="item-name">${esc(t.name)}</span>
                  ${t.loaded ? '<span class="badge loaded">loaded</span>' : ''}
                </div>
                <div class="item-right">
                  <span class="item-tok num">${fmtTok(t.tokens)}</span>
                  ${canOpen ? `<button type="button" class="open-btn" data-open-file="${esc(t.path)}" title="Open schema">${OPEN_ICON}</button>` : ''}
                </div>
              </div>
            `;
          })
          .join('');
        return `
          <details class="mcp-server" data-server="${esc(srv.name)}"${isOpen}>
            <summary>
              <span class="item-main">
                <span class="item-name">${esc(srv.name)}</span>
                ${statusBadge}
              </span>
              <span class="item-tok num">${fmtTok(srv.deferredTokens + srv.loadedTokens)} def</span>
            </summary>
            <div class="mcp-tools-list">${toolsHtml || '<div class="acc-empty">No cached tool schemas.</div>'}</div>
          </details>
        `;
      })
      .join('');

    // 3. Rules & memory
    $('sec-rules').classList.toggle('hidden', d.rules.length === 0);
    if (d.rules.length > 0) visibleSections++;
    $('count-rules').textContent = String(d.rules.length);
    $('body-rules').innerHTML = d.rules
      .map((r) => {
        const canOpen = r.path && allowed[r.path];
        return `
          <div class="item-row">
            <div class="item-main">
              <span class="item-name" title="${esc(r.path)}">${esc(r.label)}</span>
              <span class="badge">${esc(r.scope)}</span>
              ${r.loaded ? '<span class="badge loaded">active</span>' : ''}
            </div>
            <div class="item-right">
              <span class="item-tok num">${fmtTok(r.tokens)}</span>
              ${canOpen ? `<button type="button" class="open-btn" data-open-file="${esc(r.path)}" title="Open rule">${OPEN_ICON}</button>` : ''}
            </div>
          </div>
        `;
      })
      .join('');

    // 4. Skills (loaded first, then sorted by bodyTokens)
    const sortedSkills = [...d.skills].sort(
      (a, b) => Number(b.loaded) - Number(a.loaded) || b.bodyTokens - a.bodyTokens
    );
    $('sec-skills').classList.toggle('hidden', sortedSkills.length === 0);
    if (sortedSkills.length > 0) visibleSections++;
    $('count-skills').textContent = String(sortedSkills.length);
    $('body-skills').innerHTML = sortedSkills
      .map((sk) => {
        const canOpen = sk.path && allowed[sk.path];
        const tokLabel = sk.loaded
          ? `${fmtTok(sk.indexTokens)} idx · ${fmtTok(sk.bodyTokens)} read`
          : `${fmtTok(sk.indexTokens)} idx · ${fmtTok(sk.bodyTokens)} def`;
        return `
          <div class="item-row">
            <div class="item-main">
              <span class="item-name">${esc(sk.name)}</span>
              <span class="badge">${esc(sk.scope)}</span>
              ${sk.loaded ? '<span class="badge loaded">loaded</span>' : ''}
            </div>
            <div class="item-right">
              <span class="item-tok num">${tokLabel}</span>
              ${canOpen ? `<button type="button" class="open-btn" data-open-file="${esc(sk.path)}" title="Open SKILL.md">${OPEN_ICON}</button>` : ''}
            </div>
          </div>
        `;
      })
      .join('');

    // 5. Agents & subagents
    const agentRows = [];
    for (const sub of d.spawnedSubagents) {
      const stats = sub.stats
        ? `${sub.stats.steps} steps · ${fmtTok(sub.stats.promptTokens)}`
        : 'spawned';
      agentRows.push(`
        <div class="item-row">
          <div class="item-main">
            <span class="item-name">${esc(sub.role || sub.typeName)}</span>
            <span class="badge loaded">${esc(sub.typeName)}</span>
          </div>
          <div class="item-right">
            <span class="item-tok num">${stats}</span>
            ${sub.conversationId ? `<button type="button" class="open-btn" data-open-conv="${esc(sub.conversationId)}" title="Open subagent conversation">${OPEN_ICON}</button>` : ''}
          </div>
        </div>
      `);
    }
    for (const ag of d.customAgents) {
      const canOpen = ag.path && allowed[ag.path];
      agentRows.push(`
        <div class="item-row">
          <div class="item-main">
            <span class="item-name">${esc(ag.name)}</span>
            <span class="badge">${esc(ag.scope)}</span>
          </div>
          <div class="item-right">
            <span class="item-tok num">${fmtTok(ag.tokens)}</span>
            ${canOpen ? `<button type="button" class="open-btn" data-open-file="${esc(ag.path)}" title="Open agent definition">${OPEN_ICON}</button>` : ''}
          </div>
        </div>
      `);
    }
    const agentsTotal = d.spawnedSubagents.length + d.customAgents.length;
    $('sec-agents').classList.toggle('hidden', agentsTotal === 0);
    if (agentsTotal > 0) visibleSections++;
    $('count-agents').textContent = String(agentsTotal);
    $('body-agents').innerHTML = agentRows.join('');

    // 6. Artifacts
    $('sec-artifacts').classList.toggle('hidden', d.artifacts.length === 0);
    if (d.artifacts.length > 0) visibleSections++;
    $('count-artifacts').textContent = String(d.artifacts.length);
    $('body-artifacts').innerHTML = d.artifacts
      .map((a) => {
        const canOpen = a.path && allowed[a.path];
        return `
          <div class="item-row">
            <div class="item-main">
              <span class="item-name">${esc(a.name)}</span>
            </div>
            <div class="item-right">
              <span class="item-tok num">${fmtTok(a.tokens)}</span>
              ${canOpen ? `<button type="button" class="open-btn" data-open-file="${esc(a.path)}" title="Open artifact">${OPEN_ICON}</button>` : ''}
            </div>
          </div>
        `;
      })
      .join('');

    // 7. Context growth sparkline & turns
    const turns = d.turnsHistory || [];
    $('sec-growth').classList.toggle('hidden', turns.length === 0);
    if (turns.length > 0) {
      visibleSections++;
      $('count-growth').textContent = `${turns.length} ${turns.length === 1 ? 'turn' : 'turns'}`;
      const maxPrompt = Math.max(1, ...turns.map((t) => t.promptTokens));
      const w = 320;
      const h = 68;
      const pts = turns
        .map((t, i) => {
          const x = turns.length === 1 ? w / 2 : (i / (turns.length - 1)) * (w - 8) + 4;
          const y = h - 6 - (t.promptTokens / maxPrompt) * (h - 14);
          return `${x.toFixed(1)},${y.toFixed(1)}`;
        })
        .join(' ');
      const areaPts = turns.length > 1
        ? `4,${h - 4} ${pts} ${(w - 4).toFixed(1)},${h - 4}`
        : '';
      const dots = turns
        .filter((t) => t.compacted)
        .map((t) => {
          const idx = turns.indexOf(t);
          const x = turns.length === 1 ? w / 2 : (idx / (turns.length - 1)) * (w - 8) + 4;
          const y = h - 6 - (t.promptTokens / maxPrompt) * (h - 14);
          return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3.5" fill="var(--c-mcp)"/>`;
        })
        .join('');

      const chartSvg = `
        <svg class="growth-chart" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">
          ${areaPts ? `<polygon points="${areaPts}" fill="color-mix(in srgb, var(--c-messages) 14%, transparent)"/>` : ''}
          ${turns.length > 1 ? `<polyline points="${pts}" fill="none" stroke="var(--c-messages)" stroke-width="1.75" stroke-linejoin="round" stroke-linecap="round"/>` : ''}
          ${dots}
        </svg>
      `;

      const listHtml = [...turns]
        .reverse()
        .slice(0, 20)
        .map((t) => {
          const pct = Math.min(100, (t.promptTokens / maxPrompt) * 100);
          return `
            <div class="turn-row">
              <span>step ${t.stepIndex}</span>
              <span class="turn-bar-bg"><span class="turn-bar-fill${t.compacted ? ' compacted' : ''}" style="width:${pct.toFixed(1)}%"></span></span>
              <span>${fmtTok(t.promptTokens)}${t.compacted ? ' · compacted' : ''}</span>
            </div>
          `;
        })
        .join('');

      $('body-growth').innerHTML = `${chartSvg}<div class="growth-turns">${listHtml}</div>`;
    }

    $('accordions').classList.toggle('hidden', visibleSections === 0);
  }

  function render(snap) {
    state.snap = snap;
    $('loading').classList.add('hidden');

    if (!snap || !snap.found) {
      $('panel').classList.add('hidden');
      $('empty').classList.remove('hidden');
      return;
    }

    $('empty').classList.add('hidden');
    $('panel').classList.remove('hidden');

    $('used-pct').textContent = `${snap.usedPercent}% used`;
    $('used-tok').textContent = fmtTok(snap.usedTokens);

    const cache = snap.cache || {};
    $('cache-val').textContent = cache.lastPromptTokens > 0
      ? `${cache.cacheHitRatio}% cached (${fmtTok(cache.cachedTokens)})`
      : '0% cached';

    const cpCount = snap.compaction?.count || 0;
    const cpSaved = snap.compaction?.totalSavedTokens || 0;
    const cpPill = $('checkpoint-pill');
    if (cpCount > 0) {
      cpPill.textContent = `${cpCount} ${cpCount === 1 ? 'compaction' : 'compactions'} · ${fmtTok(cpSaved)} saved`;
      cpPill.classList.remove('hidden');
    } else {
      cpPill.textContent = '';
      cpPill.classList.add('hidden');
    }

    $('limit-tok').textContent = fmtLimit(snap.contextLimit);
    const ratioGroup = $('ratio-group');
    if (ratioGroup) {
      const modelName = snap.model?.label || snap.model?.id || 'Active model';
      const maxExact = Number(snap.contextLimit || 1048576).toLocaleString('en-US');
      ratioGroup.title = `${modelName} · ${maxExact} max tokens`;
    }

    renderVisuals(snap);
    renderCategoryRows(snap);
    renderDetails(snap);
  }

  // ---------- Polling ----------
  async function poll(force = false) {
    const conv = window.sidecar?.conversationId || state.fallbackConvId || '';
    const qs = new URLSearchParams();
    if (conv) qs.set('conversationId', conv);
    if (state.workspaces.length) qs.set('workspaces', state.workspaces.join('|'));
    if (!force && state.etag) qs.set('etag', state.etag);

    try {
      const f = window.sidecar?.fetch ? window.sidecar.fetch.bind(window.sidecar) : fetch;
      const res = await f(`/api/context?${qs.toString()}`, { method: 'GET' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (data.unchanged) return;
      state.etag = data.etag || '';
      render(data);
    } catch {
      // keep current UI state on transient sidecar reconnect
    }
  }

  function schedulePoll() {
    clearTimeout(state.timer);
    const delay = document.hidden ? 6000 : POLL_MS;
    state.timer = setTimeout(async () => {
      await poll(false);
      schedulePoll();
    }, delay);
  }

  // ---------- Event Wiring ----------
  function activateClickableRow(row) {
    if (row.dataset.expand) {
      const grp = row.dataset.expand;
      if (state.expandedInline.has(grp)) state.expandedInline.delete(grp);
      else state.expandedInline.add(grp);
      if (state.snap) renderCategoryRows(state.snap);
    }
    if (row.dataset.target) {
      jumpToSection(row.dataset.target);
    }
  }

  $('view-bar-btn').addEventListener('click', () => {
    state.viewMode = 'bar';
    localStorage.setItem('context_panel_view', 'bar');
    if (state.snap) renderVisuals(state.snap);
  });

  $('view-grid-btn').addEventListener('click', () => {
    state.viewMode = 'grid';
    localStorage.setItem('context_panel_view', 'grid');
    if (state.snap) renderVisuals(state.snap);
  });

  document.addEventListener('click', (e) => {
    const fileBtn = e.target.closest('[data-open-file]');
    if (fileBtn) {
      e.stopPropagation();
      openFile(fileBtn.dataset.openFile);
      return;
    }
    const convBtn = e.target.closest('[data-open-conv]');
    if (convBtn) {
      e.stopPropagation();
      openConversation(convBtn.dataset.openConv);
      return;
    }
    const row = e.target.closest('.cat-row.clickable');
    if (row) activateClickableRow(row);
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const row = e.target.closest?.('.cat-row.clickable');
    if (row) {
      e.preventDefault();
      activateClickableRow(row);
    }
  });

  document.addEventListener('mouseover', (e) => {
    const el = e.target.closest('[data-cat]');
    const next = el ? el.dataset.cat : null;
    if (next !== state.hoverKey) applyHoverHighlight(next);
  });
  document.addEventListener('mouseleave', () => applyHoverHighlight(null));

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      poll(false);
    }
    schedulePoll();
  });

  if (window.sidecar?.onWorkspaceChange) {
    window.sidecar.onWorkspaceChange((uris) => {
      state.workspaces = Array.isArray(uris) ? uris : [];
      state.etag = '';
      poll(true);
    });
  }

  // Initial boot
  (async () => {
    if (window.sidecar?.getWorkspaceUris) {
      try {
        state.workspaces = await window.sidecar.getWorkspaceUris();
      } catch {}
    }
    await poll(true);
    schedulePoll();
  })();
})();
