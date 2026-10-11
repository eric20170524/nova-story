/** CT09 labels frozen BEFORE the first CT14 model call. Never passed to inference. */
import type { ContinuityEntity } from '../schemas/continuity';
type Change={entity_id:string;attribute_id:string;operation:'assign'|'clear'|'transfer';value:string|null;from?:string};
type Case={id:string;source:string;expected:Change[];optional?:Change[];pending?:'ambiguous_entity';prior_context?:string};
type Fixture={id:string;entities:ContinuityEntity[];prior:{entity_id:string;attribute_id:string;knowledge_status:'confirmed'|'unknown';value?:string|null}[];cases:Case[]};
const actor=(id:string,name:string,character_id:number):ContinuityEntity=>({entity_id:id,project_id:10,kind:'character',display_name:name,aliases:[],character_id});
const item=(id:string,kind:ContinuityEntity['kind'],name:string,parent?:string):ContinuityEntity=>({entity_id:id,project_id:10,kind,display_name:name,aliases:[],...(parent?{parent_entity_id:parent}:{})});
const change=(entity_id:string,attribute_id:string,value:string|null,from?:string):Change=>({entity_id,attribute_id,operation:from?'transfer':value===null?'clear':'assign',value,...(from?{from}:{})});
const states=(values:Record<string,Record<string,string|null|undefined>>)=>Object.entries(values).flatMap(([entity_id,attributes])=>Object.entries(attributes).map(([attribute_id,value])=>({entity_id,attribute_id,knowledge_status:value===undefined?'unknown' as const:'confirmed' as const,...(value!==undefined?{value}:{})})));
function make(id:string,objects:[string,ContinuityEntity['kind'],string,string?][],prior:Record<string,Record<string,string|null|undefined>>,texts:[string,string,string],expected:[Change[],Change[],Change[]],pending=false):Fixture{
  return {id,entities:[actor('lin','林岚',1),actor('chen','陈月',2),...objects.map(([id,kind,name,parent])=>item(id,kind,name,parent))],prior:states(prior),cases:texts.map((source,index)=>({id:['positive','negative','variant'][index]!,source,expected:expected[index]!,...(pending&&index===1?{pending:'ambiguous_entity' as const}:{})}))};
}
export const CONTINUITY_EVAL_DATASET_VERSION='continuity-eval-1';
export const CONTINUITY_EVAL_SEEDS=[41,97] as const;
export const CONTINUITY_EVAL_FIXTURES:Fixture[]=[
  make('E01',[['coat','garment','蓝外套'],['scarf','garment','白围巾']],{coat:{wearer:'lin',color:'blue'},scarf:{wearer:'lin',color:'white'}},
    ['林岚摘下围巾，仍穿蓝外套。','林岚想摘围巾。','蓝外套仍穿着，围巾已被林岚摘下。'],[[change('scarf','wearer',null)],[],[change('scarf','wearer',null)]]),
  make('E02',[['coat','garment','红外套']],{coat:{wearer:'lin',color:'red',wetness:undefined}},
    ['林岚的红外套淋湿，颜色未变。','陈月看见林岚的红外套。','颜色仍是红色，林岚的外套已湿透。'],[[change('coat','wetness','wet')],[],[change('coat','wetness','wet')]]),
  make('E03',[['coat_lin','garment','林岚的外套'],['coat_chen','garment','陈月的外套']],{coat_lin:{wearer:'lin',integrity:'intact'},coat_chen:{wearer:'chen',integrity:'intact'}},
    ['陈月的外套破了，林岚的外套完好。','林岚看着陈月，她的外套破了。','林岚的外套完好，陈月的外套破了。'],[[change('coat_chen','integrity','damaged')],[],[change('coat_chen','integrity','damaged')]],true),
  make('E04',[['u1','prop','左侧黑伞 U1'],['u2','prop','右侧黑伞 U2']],{u1:{integrity:'intact'},u2:{integrity:'intact'}},
    ['左侧黑伞 U1 柄折断，右侧 U2 完好。','两把黑伞中有一把折断。','右侧 U2 完好，左侧 U1 柄已折断。'],[[change('u1','integrity','broken')],[],[change('u1','integrity','broken')]],true),
  make('E05',[['u1','prop','黑伞 U1']],{u1:{holder:'lin',integrity:'broken'}},
    ['林岚把 U1 递给陈月，陈月接住。','林岚递出 U1，陈月没有接住。','U1 被林岚递给陈月，陈月已接住。'],[[change('u1','holder','chen','lin')],[],[change('u1','holder','chen','lin')]]),
  make('E06',[['cup','prop','杯子']],{cup:{holder:null,integrity:'intact'}},
    ['杯子落地碎裂。','杯子差点落地，但被接住。','杯子已碎裂，碎裂发生在落地时。'],[[change('cup','integrity','broken')],[],[change('cup','integrity','broken')]]),
  make('E07',[['u1','prop','坏伞 U1'],['u2','prop','完好伞 U2']],{u1:{holder:'chen',integrity:'broken'},u2:{holder:null,integrity:'intact'}},
    ['陈月修好 U1 的伞柄。','换场后，陈月再次看见 U1。','陈月放下坏伞 U1，换用完好 U2。'],[[change('u1','integrity','intact')],[],[change('u1','holder',null),change('u2','holder','chen')]]),
  make('E08',[['u1','prop','黑伞 U1'],['room','location','房间'],['hall','location','走廊']],{u1:{holder:null,location:'room',integrity:'broken'}},
    ['U1 留在房间，人物离开后返回。','陈月离开房间。','陈月返回房间，U1 仍留在原处。'],[[],[],[]]),
  make('E09',[['door','object','木门门板'],['lock','component','门锁 L1','door']],{door:{open_state:'open',integrity:'intact'},lock:{lock_function:'broken'}},
    ['门板完好，锁 L1 已坏；随后关门。','门关上了。','门被关上，门板仍完好，L1 仍坏。'],[[change('door','open_state','closed')],[change('door','open_state','closed')],[change('door','open_state','closed')]]),
  make('E10',[['lamp','object','台灯 T1']],{lamp:{power_state:'on'}},
    ['陈月关掉台灯 T1。','陈月准备关灯。','台灯 T1 被陈月关掉。'],[[change('lamp','power_state','off')],[],[change('lamp','power_state','off')]]),
  make('E11',[['u1','prop','黑伞 U1'],['cup','prop','杯子'],['table','location','桌面']],{u1:{holder:null,location:'table'},cup:{integrity:'intact'}},
    ['陈月拿起 U1。','陈月没有拿 U1，想打碎杯子。','U1 被陈月拿起。'],[[change('u1','holder','chen')],[],[change('u1','holder','chen')]]),
  make('E12',[['u1','prop','黑伞 U1'],['table','location','桌面']],{u1:{holder:null,location:'table'}},
    ['她拿起 U1。','她拿起 U1。','她拿起 U1。'],[[change('u1','holder','chen')],[],[change('u1','holder','lin')]],true),
];
CONTINUITY_EVAL_FIXTURES.find(fixture=>fixture.id==='E02')!.cases.filter(row=>row.id!=='negative').forEach(row=>row.optional=[change('coat','color','red')]);
CONTINUITY_EVAL_FIXTURES.find(fixture=>fixture.id==='E12')!.cases.forEach((row,index)=>row.prior_context=['林岚离开，陈月留下。','林岚看着陈月。','陈月离开，林岚留下。'][index]);
// Reaffirmations of already confirmed values are allowed; unrelated new values are not.
for(const fixture of CONTINUITY_EVAL_FIXTURES)for(const row of fixture.cases)row.optional=[...(row.optional??[]),...fixture.prior.filter(cell=>cell.knowledge_status==='confirmed').map(cell=>change(cell.entity_id,cell.attribute_id,cell.value!))];
for(const fixture of CONTINUITY_EVAL_FIXTURES){Object.freeze(fixture.entities);Object.freeze(fixture.prior);Object.freeze(fixture.cases);Object.freeze(fixture);}
Object.freeze(CONTINUITY_EVAL_FIXTURES);
