const socket=io();
let state=null,timer=null,kept=new Set();
const $=id=>document.getElementById(id);
const esc=x=>String(x??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[m]));
const ROLE={
 Governor:{ru:'Губернатор',icon:'♜',ability:'Берёт 3 монеты и блокирует иностранную помощь.'},
 Cityman:{ru:'Городовой',icon:'⚓',ability:'Ворует 2 монеты и блокирует воровство.'},
 Contessa:{ru:'Графиня',icon:'👑',ability:'Блокирует убийство.'},
 Investigator:{ru:'Следователь',icon:'🔎',ability:'Смотрит одну чужую карту и меняет её; блокирует воровство.'},
 Advisor:{ru:'Советник',icon:'♢',ability:'Меняет две свои карты и блокирует воровство.'},
 Assassin:{ru:'Убийца',icon:'🗡️',ability:'Совершает убийство за 3 монеты.'}
};
const BLOCK_LABEL={Governor:'Губернатор',Cityman:'Городовой',Investigator:'Следователь',Advisor:'Советник'};
function setStatus(x){$('status').textContent=x||''}
function enter(r){if(!r?.ok)return setStatus(r?.error||'Не удалось подключиться к комнате.');$('lobby').hidden=true;$('game').hidden=false;history.replaceState(null,'',`?room=${r.code}`)}
$('create').onclick=()=>{setStatus('');socket.emit('create',{name:$('name').value},enter)};
$('join').onclick=()=>{setStatus('');socket.emit('join',{name:$('name').value,code:$('code').value},enter)};
$('start').onclick=()=>socket.emit('start');
$('copy').onclick=async()=>{try{await navigator.clipboard.writeText(location.href);$('copy').textContent='✓ Скопировано';setTimeout(()=>$('copy').textContent='🔗 Ссылка',1500)}catch{setStatus('Скопируй ссылку из адресной строки.')}};
const qs=new URLSearchParams(location.search);if(qs.get('room'))$('code').value=qs.get('room').toUpperCase();
function isMyTurn(){return !!(state?.started&&state.players[state.turn]?.id===state.me.id)}
function roleName(r){return ROLE[r]?.ru||r}
function roleCard(c,click=''){return `<div class="card ${c.alive?'':'dead'}" ${click?`onclick="${click}"`:''}><div class="eye">${c.alive?'♢':'×'}</div><div class="role">${ROLE[c.role]?.icon||'?'} ${esc(roleName(c.role))}</div><div class="ability">${esc(ROLE[c.role]?.ability||'')}</div></div>`}
function actionMenu(){const hasInvestigator=state.me.cards.some(c=>c.alive&&c.role==='Investigator');return `<div class="actiongroup"><button onclick="incomeMenu()">🪙 Взять монеты</button><button class="danger" onclick="chooseTarget('assassinate')" ${state.me.coins<3?'disabled':''}>🗡️ Убить за 3</button><button class="danger" onclick="chooseTarget('coup')" ${state.me.coins<7?'disabled':''}>💥 Убить за 7</button><button onclick="chooseTarget('steal')">⚓ Украсть 2</button><button onclick="chooseTarget('view')">👁️ Посмотреть карту</button>${hasInvestigator?'<button onclick="startExchangeSelf()">🔎 Обменять свою карту</button>':''}<button onclick="startExchange()">🔄 Обменять 2 карты</button></div>`}
function render(){if(!state)return;$('room').textContent=state.code;$('count').textContent=state.players.length+'/6';$('start').hidden=!(state.host===state.me.id&&!state.started&&state.players.length>=2);const turn=state.started?state.players[state.turn]:null;$('turn').textContent=turn?(turn.id===state.me.id?'ВАШ ХОД':`ХОД: ${esc(turn.name)}`):state.winner?`ПОБЕДИТЕЛЬ: ${esc(state.winner)}`:'ЖДЁМ ИГРОКОВ';renderPlayers();renderLog();renderLastAction();renderGame();renderNotice();renderPrivateReveal();startTimer()}
function renderPlayers(){const turnId=state.players[state.turn]?.id;$('players').innerHTML=state.players.map(p=>`<div class="player ${p.id===state.me.id?'me ':''}${p.id===turnId?'turnplayer':''}"><div class="name"><b>${esc(p.name)}</b><span>${p.id===state.host?'👑':''}${!p.alive?' ☠️':''}</span></div><div class="coins">🪙 ${p.coins}</div><div class="mini">${p.id===state.me.id?state.me.cards.filter(c=>c.alive).length+' живых карт':`${p.cards.filter(c=>c.alive).length} живых карт`}</div></div>`).join('')}
function renderLastAction(){const el=$('lastAction');const last=state.log?.[state.log.length-1];el.textContent=last||'';el.hidden=!last}
function renderLog(){const el=$('log');el.innerHTML=(state.log||[]).map(x=>`<div class="logline">${esc(x)}</div>`).join('');el.scrollTop=el.scrollHeight}
function renderGame(){const q=state.pending;let board='';if(!state.started&&!state.winner){board='<div class="deck">♛</div><div class="tablemark">ЖДЁМ НАЧАЛА ПАРТИИ</div><div class="statusline">Минимум 2 игрока. Хозяин комнаты нажмёт «Начать игру».</div>'}else if(state.winner){board=`<div class="deck">🏆</div><h2>${esc(state.winner)}</h2><div class="statusline">Партия завершена.</div>`}else{board='<div class="deck">♛</div><div class="tablemark">ПЕРЕВОРОТ</div><div class="statusline">Блефовать можно независимо от своих карт.</div>'}
 if(state.revealed?.length){board+=`<div class="revealed"><div class="revealedTitle">ВСКРЫТЫЕ КАРТЫ</div><div class="revealedCards">${state.revealed.map(c=>`<div class="revealedCard"><b>${ROLE[c.role]?.icon||'?' } ${esc(roleName(c.role))}</b><small>${esc(c.playerName)}</small></div>`).join('')}</div></div>`}
 $('board').innerHTML=board;$('hand').innerHTML=state.me.cards.filter(c=>c.alive).map(c=>roleCard(c)).join('');
 if(q?.action==='exchange'&&q.phase==='exchangeSelect'&&q.isActor){$('hand').innerHTML=state.me.cards.filter(c=>c.alive).map(c=>roleCard(c,`toggleKeep('${c.id}')`)).join('')}
 renderActions()}
function renderActions(){const q=state.pending;let html='';
 if(q?.phase==='challengeReveal'&&q.revealLoser===state.me.id){html+='<div class="statusline">Выберите карту, которую нужно вскрыть:</div>'+myRevealButtons()}
 if(q?.phase==='blockChallengeReveal'&&q.revealLoser===state.me.id){html+='<div class="statusline">Выберите карту, которую нужно вскрыть:</div>'+myRevealButtons()}
 if(q?.phase==='contessaChallengeReveal'&&q.revealLoser===state.me.id){html+='<div class="statusline">Выберите карту, которую нужно вскрыть:</div>'+myRevealButtons()}
 if(q?.phase==='challenge'&&q.actor!==state.me.id){html+=`<button class="danger" onclick="challenge()">❗ Не верю</button>`}
 if(q?.phase==='blockChallenge'&&q.actor===state.me.id){html+=`<button class="danger" onclick="challenge()">❗ Не верю в блокировку</button>`}
 if(q?.action==='foreignAid'&&q.phase==='blockWindow'&&q.actor!==state.me.id&&!q.blockedBy){html+=`<div class="statusline">Можно отменить взятие 2 монет:</div><div class="targetgrid">${['Governor'].map(role=>`<button onclick="blockRole('${role}')">♜ Губернатор — отменить помощь</button>`).join('')}</div>`}
 if(q?.action==='steal'&&q.phase==='challenge'&&q.actor!==state.me.id&&!q.blockedBy){html+=`<div class="statusline">Можно заблокировать воровство:</div><div class="targetgrid">${['Cityman','Investigator','Advisor'].map(role=>`<button onclick="blockRole('${role}')">${ROLE[role].icon} ${ROLE[role].ru} — блокировать воровство</button>`).join('')}</div>`}
 if(q?.action==='assassinate'&&q.phase==='target'&&q.target===state.me.id){html+=`<button onclick="contessa()">👑 Показать Графиню</button><div class="statusline">Или выберите карту, которую вскрыть.</div>${myRevealButtons()}`}
 if(q?.action==='assassinate'&&q.phase==='contessaChallenge'&&q.actor===state.me.id){html+=`<button class="danger" onclick="challenge()">❗ Не верю в Графиню</button>`}
 if(q?.action==='coup'&&q.phase==='target'&&q.target===state.me.id){html+='<div class="statusline">Выберите карту, которую вскрыть:</div>'+myRevealButtons()}
 if(q?.action==='view'&&q.phase==='selectView'&&q.isActor){html+='<div class="statusline">Выберите карту цели:</div><div class="targetgrid">'+targetCards(q.target)+'</div>'}
 if(q?.action==='exchange'&&q.phase==='exchangeSelect'&&q.isActor){html+='<div class="statusline">Выберите ровно 2 карты, которые хотите оставить.</div><button class="goldish" onclick="confirmExchange()">Оставить выбранные</button>'}
 if(q?.action==='exchangeSelf'&&q.phase==='exchangeSelfSelect'&&q.isActor){html+='<div class="statusline">Выберите одну свою карту для замены.</div>'+myRevealButtons()}
 if(state.privateReveal){html+=`<div class="privateReveal">Вы увидели: <b>${ROLE[state.privateReveal.role]?.icon||''} ${esc(roleName(state.privateReveal.role))}</b></div>`}
 // The turn can continue even while a normal challenge timer is still running.
 if(state.started&&isMyTurn()&&(!q||q.phase==='challenge'||q.phase==='blockWindow'||q.phase==='blockChallenge')){html+=actionMenu()}
 $('actions').innerHTML=html}
function targetCards(id){const p=state.players.find(x=>x.id===id);return (p?.cards||[]).filter(c=>c.alive).map(c=>`<button class="targetbtn" onclick="viewCard('${c.id}')">Карта ${esc(c.id.slice(-3))}</button>`).join('')}
function myRevealButtons(){return `<div class="choicecards">${state.me.cards.filter(c=>c.alive).map(c=>roleCard(c,`reveal('${c.id}')`)).join('')}</div>`}
function incomeMenu(){$('actions').innerHTML='<div class="actiongroup"><button onclick="income(1)">+1 монета</button><button onclick="income(2)">+2 монеты</button><button class="goldish" onclick="income(3)">+3 монеты <small>(можно блефовать)</small></button></div>'}
function income(n){socket.emit('action',{action:'income'+n})}
function chooseTarget(action){const candidates=state.players.filter(p=>p.id!==state.me.id&&p.alive);$('actions').innerHTML=`<div class="statusline">Выберите цель:</div><div class="targetgrid">${candidates.map(p=>`<button class="targetbtn" onclick="doTarget('${action}','${p.id}')">${esc(p.name)} · 🪙 ${p.coins}</button>`).join('')}</div>`}
function doTarget(action,id){socket.emit('action',{action,targetId:id})}
function startExchangeSelf(){socket.emit('action',{action:'exchangeSelf'})}
function startExchange(){kept.clear();socket.emit('action',{action:'exchange'})}
function toggleKeep(id){if(kept.has(id))kept.delete(id);else if(kept.size<2)kept.add(id);renderActions();$('hand').querySelectorAll('.card').forEach((x,i)=>{const c=state.me.cards.filter(c=>c.alive)[i];if(c&&kept.has(c.id))x.style.outline='3px solid #e5c06c'})}
function confirmExchange(){if(kept.size!==2)return alert('Выберите ровно две карты.');socket.emit('exchangeKeep',{ids:[...kept]});kept.clear()}
function challenge(){socket.emit('challenge')}
function blockRole(role){socket.emit('blockRole',{role})}
function viewCard(id){socket.emit('viewCard',{cardId:id})}
function contessa(){socket.emit('contessa')}
function reveal(id){socket.emit('reveal',{cardId:id})}
function renderNotice(){const q=state.pending;const el=$('notice');if(!q){el.hidden=true;return}el.hidden=false;let text='';if(q.phase==='challenge')text=q.actor===state.me.id?'Ваше действие можно оспорить.':'Игрок сделал заявление — можно не поверить.';else if(q.phase==='blockWindow')text='Взятие 2 монет можно отменить Губернатором.';else if(q.phase==='blockChallenge')text=q.actor===state.me.id?'Ваше действие заблокировали — можно не поверить в заявленную роль.':'Заявлена блокировка действия.';else if(q.phase==='selectView')text='Выберите одну карту цели.';else if(q.phase==='target')text=q.target===state.me.id?'Ваш выбор: Графиня или вскрытие карты.':'Цель выбирает карту.';else if(q.phase==='contessaChallenge')text=q.actor===state.me.id?'Соперник заявил Графиню — решите, верите ли вы.':'Игрок решает, верить ли Графине.';else if(q.phase==='exchangeSelect')text='Выберите две карты из четырёх.';else if(q.phase==='exchangeSelfSelect')text=q.actor===state.me.id?'Выберите одну свою карту для замены.':'Игрок меняет одну свою карту.';else if(q.phase==='challengeReveal'||q.phase==='blockChallengeReveal'||q.phase==='contessaChallengeReveal')text=q.revealLoser===state.me.id?'Выберите карту для вскрытия.':'Ожидаем выбор карты для вскрытия.';el.innerHTML=`<span>${text}</span>${q.expiresAt?'<span id="challengeTimer" class="timerSmall"></span>':''}`}
function renderPrivateReveal(){const el=$('privateReveal');if(!el)return;const x=state.privateReveal;el.hidden=!x;el.textContent=x?`Вы увидели карту: ${ROLE[x.role]?.icon||''} ${roleName(x.role)}`:''}
function startTimer(){clearInterval(timer);const q=state.pending;if(!q?.expiresAt)return;const update=()=>{const el=$('challengeTimer');if(!el)return;const left=Math.max(0,q.expiresAt-Date.now());const sec=Math.ceil(left/1000);el.textContent=`${String(Math.floor(sec/60)).padStart(2,'0')}:${String(sec%60).padStart(2,'0')}`;if(left<=0)clearInterval(timer)};update();timer=setInterval(update,250)}
socket.on('connect',()=>setStatus(''));
socket.on('connect_error',()=>setStatus('Нет соединения с сервером.'));
socket.on('state',s=>{state=s;if(state.started||state.winner||state.players.length){$('lobby').hidden=true;$('game').hidden=false}render()});
