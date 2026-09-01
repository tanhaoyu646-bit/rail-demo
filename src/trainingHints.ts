export type HintRole='deputy'|'dispatcher';
export const hintBanks: Record<HintRole,readonly string[]>={
  deputy:[
    '先看天气：雨雾会怎样影响前方信号的辨认？',
    '想一想：看不清前方时，瞭望方面需要怎样配合？',
    '这次天气下，制动准备是否需要提前考虑？',
    '把速度控制作为一个单独的小点想一想。',
    '预想里不要只列风险，再写一项你准备采取的措施。',
    '把纸上每条揭示涉及的地点，分别找出来看看。',
  ],
  dispatcher:[
    '先核对两份揭示的命令号是不是相同。',
    '看一下有效时间，本次出乘是否落在这个时段内？',
    '注意揭示中的行别，不能只看站名。',
    '找出发生施工的信号机，看看是进站还是出站。',
    '每条揭示中的行车办法，是不是都已核对清楚？',
    '再检查地点，两个站的要求不要混在一起。',
  ],
};
/** Repeated questions draw one short cue, exhausting a shuffled bag before repeats. */
export function createHintPicker(role:HintRole, random:()=>number=Math.random):()=>string {
  let bag:string[]=[], last='';
  return ()=>{
    if(!bag.length){
      bag=[...hintBanks[role]];
      for(let i=bag.length-1;i>0;i--){const j=Math.min(i,Math.floor(random()*(i+1)));[bag[i],bag[j]]=[bag[j],bag[i]];}
      if(bag.at(-1)===last) [bag[0],bag[bag.length-1]]=[bag[bag.length-1],bag[0]];
    }
    last=bag.pop()!;return last;
  };
}
