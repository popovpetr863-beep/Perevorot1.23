const express=require('express');
const path=require('path');
const http=require('http');
const {Server}=require('socket.io');
const app=express();
const server=http.createServer(app);
const io=new Server(server);
app.use(express.static(path.join(__dirname,'public')));
app.get('/health',(req,res)=>res.json({ok:true,game:'perevorot'}));

const rooms=new Map();
const ROLES=['Governor','Governor','Governor','Assassin','Assassin','Assassin','Cityman','Cityman','Cityman','Investigator','Investigator','Investigator','Advisor','Advisor','Advisor','Contessa','Contessa','Contessa'];
const CLAIM={tax:'Governor',assassinate:'Assassin',steal:'Cityman',view:'Investigator',exchange:'Advisor'};
const BLOCK_ROLES={steal:['Cityman','Investigator','Advisor'],foreignAid:['Governor']};
const CHALLENGE_MS=15000;
const sh=a=>{const x=[...a];for(let i=x.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[x[i],x[j]]=[x[j],x[i]]}return x};
const code=()=>{let c;do c=Math.random().toString(36).slice(2,7).toUpperCase();while(rooms.has(c));return c};
const uid=()=>Math.random().toString(36).slice(2)+Date.now().toString(36);
function roomOf(id){for(const r of rooms.values())if(r.players.some(p=>p.id===id))return r}
function getP(r,id){return r.players.find(p=>p.id===id)}
function alive(p){return !!p&&p.cards.some(c=>c.alive)}
function publicPlayer(p,self=false){return {id:p.id,name:p.name,coins:p.coins,alive:alive(p),cards:self?p.cards.map(c=>({id:c.id,role:c.role,alive:c.alive})):p.cards.map(c=>({id:c.id,alive:c.alive}))}}
function visiblePending(r,id){
 const q=r.pending;if(!q)return null;
 const out={action:q.action,actor:q.actor,target:q.target,claim:q.claim,expiresAt:q.expiresAt,phase:q.phase,chosenCard:q.chosenCard||null,drawn:q.drawn||null,blockedBy:q.blockedBy||null,revealLoser:q.revealLoser||null,revealReason:q.revealReason||null};
 if(q.actor===id)out.isActor=true;
 if(q.target===id)out.isTarget=true;
 if(q.challengeTarget===id)out.canChallenge=true;
 if(q.blockerCandidates?.includes(id))out.canBlock=true;
 if(q.preview&&q.actor===id)out.preview=q.preview;
 if(q.reactionTarget===id)out.canReact=true;
 return out;
}
function snap(r,id){
 const me=getP(r,id);
 return {code:r.code,game:'coup',host:r.host,started:r.started,turn:r.turn,phase:r.phase,winner:r.winner,players:r.players.map(p=>publicPlayer(p,p.id===id)),me:publicPlayer(me,true),pending:visiblePending(r,id),revealed:r.revealed,privateReveal:r.privateReveal?.[id]||null,log:r.log.slice(-60)};
}
function send(r){r.players.forEach(p=>io.to(p.id).emit('state',snap(r,p.id)))}
function log(r,msg){r.log.push(msg)}
function nextTurn(r){
 if(!r.players.length)return;
 let i=r.turn;
 for(let n=0;n<r.players.length;n++){i=(i+1)%r.players.length;if(alive(r.players[i])){r.turn=i;return}}
}
function checkWinner(r){const a=r.players.filter(alive);if(a.length<=1){r.started=false;r.phase='finished';r.winner=a[0]?.name||'';log(r,`🏆 ${r.winner} победил!`);return true}return false}
function bottom(r,card){if(card){card.alive=true;r.deck.unshift(card)}}
function draw(r,n){const a=[];for(let i=0;i<n&&r.deck.length;i++){const c=r.deck.pop();c.alive=true;a.push(c)}return a}
function removeLiveCard(p,cardId){const i=p.cards.findIndex(x=>x.id===cardId&&x.alive);if(i<0)return null;const [c]=p.cards.splice(i,1);c.alive=true;return c}
function loseCard(p,cardId){const c=removeLiveCard(p,cardId);if(c){c.alive=false;return c}const i=p.cards.findIndex(x=>x.alive);if(i>=0){const [fallback]=p.cards.splice(i,1);fallback.alive=false;return fallback}return null}
function replaceCard(r,p,cardId){const old=removeLiveCard(p,cardId);if(!old)return null;bottom(r,old);const replacement=draw(r,1)[0];if(replacement)p.cards.push(replacement);return replacement}
function replaceRoleCard(r,p,role){const c=p.cards.find(x=>x.alive&&x.role===role);return c?replaceCard(r,p,c.id):null}
function createRoom(s,name){const r={code:code(),host:s.id,players:[{id:s.id,name:(name||'Игрок').slice(0,20),coins:2,cards:[]}],started:false,turn:0,phase:'lobby',winner:null,pending:null,deck:[],revealed:[],privateReveal:{},log:[]};rooms.set(r.code,r);s.join(r.code);return r}
function startGame(r){
 r.deck=sh(ROLES.map(role=>({id:uid(),role,alive:true})));
 r.revealed=[];r.privateReveal={};r.players.forEach(p=>{p.coins=2;p.cards=[r.deck.pop(),r.deck.pop()];});
 r.turn=Math.floor(Math.random()*r.players.length);while(!alive(r.players[r.turn]))r.turn=(r.turn+1)%r.players.length;
 r.started=true;r.phase='play';r.pending=null;r.winner=null;
 log(r,`♛ Игра началась. Первый ход: ${r.players[r.turn].name}.`);send(r)
}
function clearPending(r){if(r.pending?.timer)clearTimeout(r.pending.timer);r.pending=null}
function schedule(r,ms,fn){if(r.pending?.timer)clearTimeout(r.pending.timer);r.pending.timer=setTimeout(()=>{if(r.pending)fn()},ms)}
function advanceAfterAction(r){if(!checkWinner(r)){nextTurn(r);r.phase='play'}}
function finishAction(r,advance=true){clearPending(r);if(advance)advanceAfterAction(r);send(r)}
function restartChallenge(r,fn){if(r.pending)r.pending.expiresAt=Date.now()+CHALLENGE_MS;send(r);schedule(r,CHALLENGE_MS,fn)}
function revealToTable(r,p,card,reason){if(!card)return;const already=r.revealed.some(x=>x.id===card.id);if(!already)r.revealed.push({id:card.id,role:card.role,playerId:p.id,playerName:p.name,reason})}
function privateShow(r,playerId,role){r.privateReveal[playerId]={role,at:Date.now()};setTimeout(()=>{if(r.privateReveal?.[playerId]?.role===role){delete r.privateReveal[playerId];send(r)}},8000)}
function resolveChallenge(r){
 const q=r.pending;if(!q||q.phase!=='challenge')return;
 const actor=getP(r,q.actor);if(!actor)return;
 if(!q.challenger){
   if(q.action==='assassinate'){q.phase='target';q.expiresAt=0;q.reactionTarget=q.target;send(r);return}
   if(q.action==='tax'){actor.coins+=3;log(r,`💰 ${actor.name} получил 3 монеты.`);finishAction(r,false);return}
   if(q.action==='steal'){q.phase='resolve';resolvePending(r);return}
   if(q.action==='view'){q.phase='resolve';resolvePending(r);return}
   if(q.action==='exchange'){q.phase='exchangeSelect';send(r);return}
   if(q.action==='foreignAid'){actor.coins+=2;log(r,`💰 ${actor.name} получил 2 монеты иностранной помощи.`);finishAction(r,false);return}
   return;
 }
 const has=actor.cards.some(c=>c.alive&&c.role===q.claim);
 if(has){
   q.revealLoser=q.challenger;q.revealReason='оспаривание';q.phase='challengeReveal';q.expiresAt=0;q.challengeResult='claimTrue';
   log(r,`🛡️ ${actor.name} доказал роль ${q.claim}. ${getP(r,q.challenger)?.name||'Игрок'} должен выбрать карту для вскрытия.`);send(r);return;
 }
 q.revealLoser=actor.id;q.revealReason='оспаривание';q.phase='challengeReveal';q.expiresAt=0;q.challengeResult='claimFalse';
 log(r,`❌ ${actor.name} не смог доказать роль ${q.claim}. ${actor.name} должен выбрать карту для вскрытия.`);send(r);
}
function resolveBlockChallenge(r){
 const q=r.pending;if(!q||q.phase!=='blockChallenge')return;
 const blocker=getP(r,q.blockedBy),actor=getP(r,q.actor);if(!blocker||!actor)return;
 if(!q.blockChallenger){
   if(q.action==='steal'){log(r,`🛡️ ${blocker.name} заблокировал воровство.`);finishAction(r,false);return}
   if(q.action==='foreignAid'){log(r,`🛡️ ${blocker.name} отменил иностранную помощь.`);finishAction(r,false);return}
   return;
 }
 const has=blocker.cards.some(c=>c.alive&&c.role===q.blockClaim);
 if(has){
   q.revealLoser=q.blockChallenger;q.revealReason='оспаривание блокировки';q.phase='blockChallengeReveal';q.expiresAt=0;q.challengeResult='blockTrue';
   log(r,`🛡️ ${blocker.name} доказал роль ${q.blockClaim}. ${getP(r,q.blockChallenger)?.name||'Игрок'} должен выбрать карту для вскрытия.`);send(r);return;
 }
 q.revealLoser=blocker.id;q.revealReason='оспаривание блокировки';q.phase='blockChallengeReveal';q.expiresAt=0;q.challengeResult='blockFalse';
 log(r,`❌ ${blocker.name} не смог доказать роль ${q.blockClaim}. ${blocker.name} должен выбрать карту для вскрытия.`);send(r);
}
function resolvePending(r){
 const q=r.pending;if(!q)return;
 const a=getP(r,q.actor),t=q.target?getP(r,q.target):null;if(!a)return;
 if(q.phase==='challenge'){resolveChallenge(r);return}
 if(q.phase==='blockChallenge'){resolveBlockChallenge(r);return}
 if(q.phase==='challengeReveal'||q.phase==='blockChallengeReveal')return;
 if(q.action==='steal'&&q.phase==='resolve'){
   const n=Math.min(2,t?.coins||0);if(t)t.coins-=n;a.coins+=n;log(r,`🪙 ${a.name} украл ${n} монет у ${t.name}.`);finishAction(r,q.turnAdvanced?false:true);return;
 }
 if(q.action==='foreignAid'&&q.phase==='blockWindow'){a.coins+=2;log(r,`💰 ${a.name} получил 2 монеты иностранной помощи.`);finishAction(r,q.turnAdvanced?false:true);return}
 if(q.action==='assassinate'&&q.phase==='target')return;
 if(q.action==='view'&&q.phase==='resolve'){
   const card=t?.cards.find(c=>c.id===q.chosenCard&&c.alive);if(card){privateShow(r,a.id,card.role);replaceCard(r,t,card.id);log(r,`👁️ ${a.name} посмотрел карту ${t.name} и заменил её новой картой.`)}
   finishAction(r,q.turnAdvanced?false:true);return;
 }
 if(q.action==='exchangeSelf'&&q.phase==='exchangeSelfSelect'){return}
 if(q.action==='exchange'&&q.phase==='exchangeSelect'){return}
}
function beginAction(r,p,action,targetId){
 if(action==='income3')action='tax';
 if(!r.started||!p||r.players[r.turn]?.id!==p.id||!alive(p))return;
 // A player may begin the next turn while another action's challenge window is still open.
 // The old action is settled first; the new action then gets its own fresh 15-second window.
 if(r.pending){
   // Следующий игрок может начать свой ход, не дожидаясь конца обычного окна оспаривания.
   // Перед новым действием старое окно окончательно разрешается, а его таймер уничтожается.
   if(r.pending.phase==='challenge')resolveChallenge(r);
   else if(r.pending.phase==='blockWindow')resolvePending(r);
   else if(r.pending.phase==='blockChallenge')resolveBlockChallenge(r);
   if(r.pending)return;
 }
 const t=targetId?getP(r,targetId):null;
 if(['assassinate','coup','steal','view'].includes(action)&&(!t||t.id===p.id||!alive(t)))return;
 if(action==='assassinate'&&p.coins<3)return;
 if(action==='coup'&&p.coins<7)return;
 if(action==='assassinate')p.coins-=3;
 if(action==='coup'){p.coins-=7;r.pending={action,actor:p.id,target:t.id,phase:'target',expiresAt:0,turnAdvanced:true};log(r,`💥 ${p.name} выбрал цель: ${t.name}.`);advanceAfterAction(r);send(r);return}
 if(action==='income1'){p.coins+=1;log(r,`🪙 ${p.name} взял 1 монету.`);advanceAfterAction(r);send(r);return}
 if(action==='income2'){
   r.pending={action:'foreignAid',actor:p.id,claim:'Governor',phase:'blockWindow',expiresAt:Date.now()+CHALLENGE_MS,turnAdvanced:true,blockerCandidates:r.players.filter(x=>x.id!==p.id&&alive(x)).map(x=>x.id)};
   log(r,`💰 ${p.name} взял 2 монеты.`);advanceAfterAction(r);restartChallenge(r,()=>{if(r.pending?.phase==='blockWindow')resolvePending(r)});return;
 }
 if(action==='tax'){
   r.pending={action:'tax',actor:p.id,claim:'Governor',phase:'challenge',expiresAt:Date.now()+CHALLENGE_MS,turnAdvanced:true,challenger:null};
   log(r,`💰 ${p.name} заявил роль Губернатора и берёт 3 монеты.`);advanceAfterAction(r);restartChallenge(r,()=>{if(r.pending?.phase==='challenge')resolveChallenge(r)});return;
 }
 if(action==='exchangeSelf'){
   if(!p.cards.some(c=>c.alive&&c.role==='Investigator'))return;
   r.pending={action:'exchangeSelf',actor:p.id,phase:'exchangeSelfSelect',expiresAt:0,turnAdvanced:true};
   log(r,`🔎 ${p.name} решил заменить одну свою карту.`);send(r);return;
 }
 if(action==='steal'||action==='assassinate'||action==='view'||action==='exchange'){
   const q={action,actor:p.id,target:t?.id,claim:CLAIM[action],phase:'challenge',expiresAt:Date.now()+CHALLENGE_MS,turnAdvanced:true,challenger:null};
   if(action==='view')q.phase='selectView',q.expiresAt=0;
   if(action==='exchange'){
     q.drawnCards=draw(r,2);q.drawnIds=q.drawnCards.map(c=>c.id);p.cards.push(...q.drawnCards);q.drawn=q.drawnIds;
   }
   r.pending=q;log(r,`🎭 ${p.name} заявил роль ${q.claim}.`);advanceAfterAction(r);send(r);
   if(q.phase==='challenge')schedule(r,CHALLENGE_MS,()=>{if(r.pending?.phase==='challenge')resolveChallenge(r)});
 }
}
function challenge(r,p){
 const q=r.pending;if(!q||q.phase!=='challenge'||q.actor===p.id||!alive(p))return;
 q.challenger=p.id;log(r,`❗ ${p.name} не поверил заявлению игрока ${getP(r,q.actor).name}.`);resolveChallenge(r);send(r)
}
function challengeBlock(r,p){
 const q=r.pending;if(!q||q.phase!=='blockChallenge'||q.actor!==p.id||!alive(p))return;
 const blocker=getP(r,q.blockedBy);
 if(!blocker)return;
 q.blockChallenger=p.id;
 log(r,`❗ ${p.name} не поверил, что у ${blocker.name} есть ${q.blockClaim}.`);
 resolveBlockChallenge(r);send(r);
}
function selectView(r,p,cardId){
 const q=r.pending;if(!q||q.action!=='view'||q.actor!==p.id||q.phase!=='selectView')return;
 const t=getP(r,q.target),card=t?.cards.find(c=>c.id===cardId&&c.alive);if(!card)return;
 q.chosenCard=cardId;q.phase='challenge';q.expiresAt=Date.now()+CHALLENGE_MS;q.challenger=null;log(r,`👁️ ${p.name} выбрал карту ${t.name} для просмотра.`);send(r);schedule(r,CHALLENGE_MS,()=>{if(r.pending?.phase==='challenge')resolveChallenge(r)})
}
function selectExchange(r,p,ids){
 const q=r.pending;if(!q||q.action!=='exchange'||q.actor!==p.id||q.phase!=='exchangeSelect')return;
 const unique=[...new Set(ids||[])];if(unique.length!==2)return;
 const all=p.cards.filter(c=>c.alive);if(unique.some(id=>!all.some(c=>c.id===id)))return;
 const removed=all.filter(c=>!unique.includes(c.id));removed.forEach(c=>{c.alive=true;bottom(r,c)});p.cards=p.cards.filter(c=>unique.includes(c.id)||!c.alive);log(r,`🔄 ${p.name} оставил две карты, остальные вернул вниз колоды.`);finishAction(r,q.turnAdvanced?false:true)
}
function selectExchangeSelf(r,p,cardId){
 const q=r.pending;if(!q||q.action!=='exchangeSelf'||q.actor!==p.id||q.phase!=='exchangeSelfSelect')return;
 const card=p.cards.find(c=>c.id===cardId&&c.alive);if(!card)return;
 replaceCard(r,p,cardId);log(r,`🔎 ${p.name} заменил одну свою карту на новую.`);finishAction(r,q.turnAdvanced?false:true)
}
function resolveChallengeReveal(r,p,cardId){
 const q=r.pending;if(!q||!['challengeReveal','blockChallengeReveal'].includes(q.phase)||q.revealLoser!==p.id)return;
 const card=p.cards.find(c=>c.id===cardId&&c.alive);if(!card)return;
 loseCard(p,cardId);revealToTable(r,p,card,q.revealReason||'оспаривание');
 if(q.phase==='challengeReveal'){
   if(q.challengeResult==='claimTrue'){
     const actor=getP(r,q.actor);if(actor)replaceRoleCard(r,actor,q.claim);
     log(r,`🛡️ ${actor?.name||'Игрок'} доказал ${q.claim}. ${p.name} вскрыл карту.`);
     if(q.action==='assassinate'){q.phase='target';q.expiresAt=0;q.reactionTarget=q.target;send(r);return}
     if(q.action==='tax'){actor.coins+=3;finishAction(r,false);return}
     if(q.action==='steal'){q.phase='resolve';resolvePending(r);return}
     if(q.action==='view'){q.phase='resolve';resolvePending(r);return}
     if(q.action==='exchange'){q.phase='exchangeSelect';send(r);return}
     if(q.action==='foreignAid'){finishAction(r,false);return}
   }else{
     const actor=getP(r,q.actor);log(r,`❌ ${actor?.name||'Игрок'} вскрыл карту ${card.role}.`);
     if(q.action==='assassinate'){if(actor)actor.coins+=3;finishAction(r,false);return}
     if(q.action==='tax'){finishAction(r,false);return}
     if(q.action==='steal'){q.phase='resolve';resolvePending(r);return}
     if(q.action==='view'){finishAction(r,false);return}
     if(q.action==='exchange'){finishAction(r,false);return}
     if(q.action==='foreignAid'){if(actor)actor.coins+=2;finishAction(r,false);return}
   }
 }else{
   const actor=getP(r,q.actor);const blocker=getP(r,q.blockedBy);
   if(q.challengeResult==='blockTrue'){
     log(r,`🛡️ ${blocker?.name||'Игрок'} доказал ${q.blockClaim}. ${p.name} вскрыл карту.`);
     if(q.action==='steal'||q.action==='foreignAid'){finishAction(r,false);return}
   }else{
     log(r,`❌ ${blocker?.name||'Игрок'} не смог доказать ${q.blockClaim}. ${p.name} вскрыл карту.`);
     if(q.action==='steal'){q.blockedBy=null;q.blockClaim=null;q.phase='resolve';resolvePending(r);return}
     if(q.action==='foreignAid'){if(actor)actor.coins+=2;finishAction(r,false);return}
   }
 }
 send(r)
}
function targetReveal(r,p,cardId){
 const q=r.pending;if(!q||q.phase!=='target'||q.target!==p.id)return;
 const card=p.cards.find(c=>c.id===cardId&&c.alive);if(!card)return;
 if(q.action==='assassinate'){
   if(q.revealedId)return; q.revealedId=cardId;loseCard(p,cardId);revealToTable(r,p,card,'убийство');log(r,`🗡️ ${getP(r,q.actor).name} убил карту ${p.name}: ${card.role}.`);finishAction(r,false);return;
 }
 if(q.action==='coup'){loseCard(p,cardId);revealToTable(r,p,card,'переворот');log(r,`💥 ${getP(r,q.actor).name} совершил переворот против ${p.name}. Вскрыта карта: ${card.role}.`);finishAction(r,false)}
}
function contessa(r,p){
 const q=r.pending;if(!q||q.action!=='assassinate'||q.phase!=='target'||q.target!==p.id)return;
 q.phase='contessaChallenge';q.blockedBy=p.id;q.blockClaim='Contessa';q.expiresAt=Date.now()+CHALLENGE_MS;q.challenger=null;log(r,`👑 ${p.name} заявил, что у него есть Графиня и заблокировал убийство.`);send(r);schedule(r,CHALLENGE_MS,()=>{if(r.pending?.phase==='contessaChallenge')finishAction(r,false)})
}
function challengeContessa(r,p){
 const q=r.pending;if(!q||q.phase!=='contessaChallenge'||q.actor!==p.id)return;
 const target=getP(r,q.blockedBy);if(!target)return;
 const has=target.cards.some(c=>c.alive&&c.role==='Contessa');
 if(has){q.revealLoser=p.id;q.revealReason='оспаривание Графини';q.phase='contessaChallengeReveal';q.expiresAt=0;q.challengeResult='contessaTrue';log(r,`🛡️ ${target.name} доказал наличие Графини. ${p.name} должен выбрать карту.`);send(r);return}
 q.revealLoser=target.id;q.revealReason='ложная Графиня';q.phase='contessaChallengeReveal';q.expiresAt=0;q.challengeResult='contessaFalse';log(r,`❌ ${target.name} блефовал с Графиней. ${target.name} должен выбрать карту.`);send(r);
}
function resolveContessaReveal(r,p,cardId){
 const q=r.pending;if(!q||q.phase!=='contessaChallengeReveal'||q.revealLoser!==p.id)return;
 const card=p.cards.find(c=>c.id===cardId&&c.alive);if(!card)return;loseCard(p,cardId);revealToTable(r,p,card,q.revealReason);
 const target=getP(r,q.blockedBy),actor=getP(r,q.actor);
 if(q.challengeResult==='contessaTrue'){
   if(target)replaceRoleCard(r,target,'Contessa');log(r,`🛡️ ${target?.name||'Игрок'} доказал Графиню. ${p.name} вскрыл карту.`);finishAction(r,false);return;
 }
 log(r,`❌ ${target?.name||'Игрок'} вскрыл карту ${card.role}. Убийство продолжается.`);q.phase='target';q.expiresAt=0;send(r)
}
function blockStealOrAid(r,p){
 const q=r.pending;if(!q||!['steal','foreignAid'].includes(q.action))return;
 if(q.phase!=='challenge'&&q.phase!=='blockChallenge')return;
 if(q.action==='steal'&&q.phase!=='challenge')return;
 if(q.action==='foreignAid'&&q.phase!=='blockWindow')return;
 if(q.actor===p.id||!alive(p))return;
 const allowed=q.action==='foreignAid'?['Governor']:BLOCK_ROLES.steal;
 if(!allowed.some(()=>true))return;
 q.blockedBy=p.id;q.blockClaim=null;
 // The blocker chooses the role they claim. The client sends the role through blockRole.
}
function chooseBlock(r,p,role){
 const q=r.pending;if(!q||q.actor===p.id||!alive(p))return;
 const allowed=q.action==='foreignAid'?['Governor']:BLOCK_ROLES.steal;if(!allowed.includes(role))return;
 if(q.action==='foreignAid'&&q.phase!=='blockWindow')return;
 if(q.action==='steal'&&q.phase!=='challenge')return;
 q.blockedBy=p.id;q.blockClaim=role;q.phase='blockChallenge';q.expiresAt=Date.now()+CHALLENGE_MS;q.challenger=null;
 log(r,`🛡️ ${p.name} заявил, что ${role} блокирует действие.`);send(r);schedule(r,CHALLENGE_MS,()=>{if(r.pending?.phase==='blockChallenge')resolveBlockChallenge(r)})
}
io.on('connection',s=>{
 s.on('create',({name},cb)=>{const r=createRoom(s,name);cb?.({ok:true,code:r.code});send(r)});
 s.on('join',({name,code:c},cb)=>{const r=rooms.get(String(c||'').toUpperCase());if(!r)return cb?.({ok:false,error:'Комната не найдена'});if(r.started)return cb?.({ok:false,error:'Игра уже началась'});if(r.players.length>=6)return cb?.({ok:false,error:'Максимум 6 игроков'});r.players.push({id:s.id,name:(name||'Игрок').slice(0,20),coins:2,cards:[]});s.join(r.code);cb?.({ok:true,code:r.code});send(r)});
 s.on('start',()=>{const r=roomOf(s.id);if(r&&r.host===s.id&&!r.started&&r.players.length>=2)startGame(r)});
 s.on('action',({action,targetId})=>{const r=roomOf(s.id);if(r){beginAction(r,getP(r,s.id),action,targetId);send(r)}});
 s.on('challenge',()=>{const r=roomOf(s.id);if(r){const p=getP(r,s.id);const q=r.pending;if(q?.phase==='contessaChallenge')challengeContessa(r,p);else if(q?.phase==='blockChallenge')challengeBlock(r,p);else challenge(r,p);send(r)}});
 s.on('blockRole',({role})=>{const r=roomOf(s.id);if(r){chooseBlock(r,getP(r,s.id),role);send(r)}});
 s.on('reveal',({cardId})=>{const r=roomOf(s.id);if(r){const p=getP(r,s.id);const q=r.pending;if(q?.phase==='challengeReveal'||q?.phase==='blockChallengeReveal')resolveChallengeReveal(r,p,cardId);else if(q?.phase==='contessaChallengeReveal')resolveContessaReveal(r,p,cardId);else if(q?.phase==='exchangeSelfSelect')selectExchangeSelf(r,p,cardId);else targetReveal(r,p,cardId);send(r)}});
 s.on('contessa',()=>{const r=roomOf(s.id);if(r){contessa(r,getP(r,s.id));send(r)}});
 s.on('viewCard',({cardId})=>{const r=roomOf(s.id);if(r){selectView(r,getP(r,s.id),cardId);send(r)}});
 s.on('exchangeKeep',({ids})=>{const r=roomOf(s.id);if(r){selectExchange(r,getP(r,s.id),ids);send(r)}});
 s.on('disconnect',()=>{const r=roomOf(s.id);if(!r)return;r.players=r.players.filter(p=>p.id!==s.id);if(!r.players.length)rooms.delete(r.code);else{if(r.host===s.id)r.host=r.players[0].id;if(r.turn>=r.players.length)r.turn=0;send(r)}});
});
server.listen(process.env.PORT||3000,'0.0.0.0');
