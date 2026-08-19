(() => {
  'use strict';
  const c = window.QUIZ_CONFIG;
  if (!c) throw new Error('缺少 quiz-config.js');
  const app = document.querySelector('#app');
  const deviceKey = `invite_quiz_device_${c.projectId}`;
  let session = null;
  let answers = [];
  let at = 0;

  document.title = c.title;
  document.querySelector('meta[name="description"]').content = c.description;
  Object.entries(c.theme || {}).forEach(([key, value]) => document.documentElement.style.setProperty(`--${key}`, value));
  document.querySelector('.loading-mark').textContent = c.seal;
  document.querySelector('.loading p').textContent = c.loadingText || '正在打开测试';

  function randomToken() {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    return [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
  }
  function storedToken() { return localStorage.getItem(deviceKey); }
  function deviceToken() {
    let token = storedToken();
    if (!token) {
      token = randomToken();
      localStorage.setItem(deviceKey, token);
    }
    return token;
  }
  function iframeApi(action, data = {}) {
    return new Promise((resolve, reject) => {
      const requestId = randomToken().slice(0, 24);
      const frame = document.createElement('iframe');
      const form = document.createElement('form');
      const frameName = `quiz_api_${requestId}`;
      const apiOrigin = new URL(c.apiUrl).origin;
      frame.name = frameName;
      frame.style.display = 'none';
      form.method = 'POST';
      form.action = c.apiUrl;
      form.target = frameName;
      form.style.display = 'none';
      const fields = { action, projectId: c.projectId, ...data, transport: 'iframe', requestId, parentOrigin: location.origin };
      Object.entries(fields).forEach(([name, value]) => {
        const input = document.createElement('input');
        input.type = 'hidden';
        input.name = name;
        input.value = String(value);
        form.appendChild(input);
      });
      const cleanup = () => {
        clearTimeout(timer);
        window.removeEventListener('message', onMessage);
        form.remove();
        frame.remove();
      };
      const onMessage = (event) => {
        const message = event.data || {};
        if (event.origin !== apiOrigin || message.source !== 'invite-quiz-api' || message.requestId !== requestId) return;
        cleanup();
        if (message.status >= 400) reject(new Error(message.payload?.message || message.payload?.error || '服务暂不可用'));
        else resolve(message.payload);
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('授权通道连接超时，请在系统浏览器中打开'));
      }, 25000);
      window.addEventListener('message', onMessage);
      document.body.append(frame, form);
      form.submit();
    });
  }
  async function api(action, data = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetch(c.apiUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, projectId: c.projectId, ...data }),
        signal: controller.signal
      });
      const json = await response.json().catch(() => ({ ok: false, error: '服务暂不可用' }));
      if (!response.ok) throw new Error(json.message || json.error || '服务暂不可用');
      return json;
    } catch (error) {
      if (error.name === 'AbortError' || error instanceof TypeError) {
        return iframeApi(action, data);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
  function top(tag = '仅限受邀者') {
    return `<header class="topbar"><div class="brand"><span class="seal">${c.seal}</span><span>${c.brand}</span></div><span class="tag">${tag}</span></header>`;
  }
  async function boot() {
    try {
      const url = new URL(location.href);
      const owner = url.searchParams.get('owner');
      const invite = url.searchParams.get('invite');
      let result;
      if (owner) {
        const token = deviceToken();
        result = await api('owner', { key: owner, sessionToken: token });
        if (!result.ok) throw new Error(result.error);
        session = { role: 'owner', token };
        history.replaceState({}, '', url.pathname);
      } else if (invite) {
        const token = deviceToken();
        result = await api('claim', { invite, sessionToken: token });
        if (!result.ok) throw new Error(result.error);
        session = { role: 'viewer', token };
        history.replaceState({}, '', url.pathname);
      } else {
        const token = storedToken();
        if (!token) return gate(c.gateText || '此测试只接受创建者发出的专属邀请');
        result = await api('session', { sessionToken: token });
        if (!result.ok) return gate('此浏览器尚未领取有效邀请');
        session = { role: result.role, token };
      }
      if (session.role === 'owner') admin(); else home();
    } catch (error) {
      gate(error.message);
    }
  }
  function gate(message = '这是一份限量测试') {
    const retry = /网络|连接|服务/.test(message);
    app.className = 'shell';
    app.innerHTML = `${top('邀请制')}<section class="gate"><span class="seal">止</span><h1>${retry ? '连接未完成' : '测试未开启'}</h1><p>${message}</p>${retry ? '<button class="primary" id="retry">重新验证</button><p>仍无法进入时，请关闭当前页面，切换 Wi-Fi / 手机流量后重新打开原邀请链接。</p>' : '<div class="gate-code">请向邀请人获取尚未使用的专属链接</div><p>每个邀请只能由一个浏览器领取，转发后不能在另一台设备使用。</p>'}</section>`;
    if (retry) document.querySelector('#retry').onclick = () => location.reload();
  }
  function admin() {
    app.className = 'shell';
    app.innerHTML = `${top('创建者入口')}<section class="admin"><h1>邀请管理</h1><p>每条链接第一次领取后绑定一个浏览器。领取者可以反复测试，但不能把链接转交给另一个设备。</p><div class="admin-card"><h3>生成设备邀请</h3><button class="primary" id="make">生成专属邀请链接</button><div id="invite-out"></div></div><div class="admin-card"><h3>预览测试</h3><button class="secondary" id="preview">进入测试</button></div></section>`;
    document.querySelector('#make').onclick = makeInvite;
    document.querySelector('#preview').onclick = home;
  }
  async function makeInvite() {
    const button = document.querySelector('#make');
    const output = document.querySelector('#invite-out');
    button.disabled = true;
    try {
      const result = await api('create', { sessionToken: session.token });
      if (!result.ok) throw new Error(result.error);
      const url = `${location.origin}${location.pathname}?invite=${encodeURIComponent(result.invite)}`;
      output.innerHTML = `<div class="invite-box">${url}</div><div class="copy-row"><button class="primary" id="copy">复制邀请链接</button><button id="again">再生成</button></div>`;
      document.querySelector('#copy').onclick = async () => {
        await navigator.clipboard.writeText(url);
        document.querySelector('#copy').textContent = '已复制';
      };
      document.querySelector('#again').onclick = makeInvite;
    } catch (error) {
      output.innerHTML = `<p class="error">${error.message}</p>`;
    } finally {
      button.disabled = false;
    }
  }
  function home() {
    app.className = 'shell night';
    app.innerHTML = `${top(session.role === 'owner' ? '创建者预览' : '受邀测试')}<section class="hero"><div class="orb">${c.orbText}</div><p class="kicker">${c.kicker}</p><h1>${c.heading}<br><em>${c.accentHeading}</em></h1><p class="lead">${c.lead}</p><button class="primary" id="start">${c.startText || '开始测试'}</button><p class="micro">无需登录 · 约 ${c.minutes || 2} 分钟 · 仅作娱乐</p></section>`;
    document.querySelector('#start').onclick = () => { answers = []; at = 0; question(); };
  }
  function question() {
    const item = c.questions[at];
    app.className = 'shell';
    app.innerHTML = `<header class="quiz-header"><button class="back" id="back">←</button><span class="progress">${String(at + 1).padStart(2, '0')} / ${String(c.questions.length).padStart(2, '0')}</span><span class="tag">${item.chapter}</span></header><div class="bar"><i style="width:${(at + 1) / c.questions.length * 100}%"></i></div><section class="question"><small>${item.eyebrow}</small><h2>${item.prompt}</h2><p class="hint">${c.hint || '凭第一直觉，不必寻找正确答案'}</p><div class="answers">${item.options.map((option, index) => `<button class="answer" data-i="${index}"><span>${'ABCDEFGHIJKLMNOPQRSTUVWXYZ'[index]}</span><p>${option.text}</p><b>›</b></button>`).join('')}</div></section>`;
    document.querySelector('#back').onclick = () => { if (at) { at -= 1; answers.pop(); question(); } else home(); };
    document.querySelectorAll('.answer').forEach((button) => button.onclick = () => {
      answers.push(Number(button.dataset.i));
      at += 1;
      if (at < c.questions.length) question(); else result();
    });
  }
  function result() {
    const scores = Object.fromEntries(Object.keys(c.profiles).map((key) => [key, 0]));
    answers.forEach((answer, index) => Object.entries(c.questions[index].options[answer].scores).forEach(([key, value]) => { scores[key] = (scores[key] || 0) + value; }));
    const dimensions = Object.keys(scores).sort((a, b) => scores[b] - scores[a]);
    const profile = c.profiles[dimensions[0]];
    app.className = 'shell';
    app.innerHTML = `${top('结果已生成')}<section class="result-hero"><p class="kicker">${c.resultKicker || '你的测试结果'}</p><div class="identity"><span>${c.identityLabel || '类型'}</span><b>${profile.identity}</b></div><h1>${profile.name}</h1><p>${profile.summary}</p><p>主维度 · ${dimensions[0]}　副维度 · ${dimensions[1] || dimensions[0]}</p></section><section class="result-section"><div class="section-title"><span>壹</span><h2>${c.talentLabel || '自带天赋'}</h2></div><article class="trait"><h3>${profile.talentTitle}</h3><p>${profile.talent}</p></article></section><section class="result-section"><div class="section-title"><span>贰</span><h2>${c.flawLabel || '致命缺陷'}</h2></div><article class="trait"><h3>${profile.flawTitle}</h3><p>${profile.flaw}</p></article></section><section class="fate"><small>${c.fateLabel || '命运判词'}</small><blockquote>${profile.fate}</blockquote><p>${profile.epilogue || ''}</p></section><div class="actions"><button class="secondary" id="redo">再测一次</button>${session.role === 'owner' ? '<button class="secondary" id="manage">返回邀请管理</button>' : ''}</div>`;
    document.querySelector('#redo').onclick = home;
    if (session.role === 'owner') document.querySelector('#manage').onclick = admin;
  }
  boot();
})();
