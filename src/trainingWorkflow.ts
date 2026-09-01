export type TrainingStage = 'kiosk' | 'meeting' | 'dispatcher' | 'cab' | 'complete';
export type PersonRole = 'deputy' | 'dispatcher';
export type PersonAction = 'dialogue' | 'meeting' | 'check' | 'review';

export class TrainingWorkflow {
  stage: TrainingStage = 'kiosk';
  pendingDifference: 'published' | 'card' | null = null;
  actionFor(role: PersonRole): PersonAction {
    if (role === 'dispatcher' && this.pendingDifference) return 'review';
    if (role === 'deputy' && this.stage === 'meeting') return 'meeting';
    if (role === 'dispatcher' && this.stage === 'dispatcher') return 'check';
    return 'dialogue';
  }
  complete(stage: Exclude<TrainingStage, 'complete'>): boolean {
    if (this.stage !== stage || this.pendingDifference) return false;
    this.stage = ({kiosk:'meeting', meeting:'dispatcher', dispatcher:'cab', cab:'complete'} as const)[stage];
    return true;
  }
}

export const stageDialogue: Record<PersonRole, Record<TrainingStage, readonly string[]>> = {
  deputy: {
    kiosk: ['先把一体机上的出勤手续完成，我们再开小组会。', '我在这里等你。先核对揭示，拿不准的内容可以先问。', '现在还没到填写预想这一步，先完成一体机操作。'],
    meeting: ['我们结合本次揭示和天气，商量出乘预想。'],
    dispatcher: ['刚才小组会已经开完了，接下来请找出勤调度员进行人人核对。', '预想已经记在手帐里了，可以举近再看一遍，再去调度台。', '我们讨论过的要点都记下了。还有疑问可以再问我，不必重开小组会。'],
    cab: ['小组会和人人核对都完成了，接下来进行人车核对。', '上车后还要核对卡内揭示，不能省略这一步。'],
    complete: ['本轮核对已经完成，可以回顾一下遇到的差异。', '本轮流程结束了，手帐仍然可以拿出来查看。'],
  },
  dispatcher: {
    kiosk: ['先在一体机完成出勤手续，有揭示差异就报告复核。', '你可以先问我一个要点，不需要现在填写手帐。', '一体机核对完成后，先与副司机开小组会，再回来进行人人核对。'],
    meeting: ['你们先开好小组会，完成出乘预想，再来找我核对。', '现在是小组会阶段。有不清楚的要点可以问我，手帐和副司机一起填写。', '结合本次揭示和雨雾天气把预想想清楚，讨论完再来核对。'],
    dispatcher: ['小组会已完成，我们开始本次人人核对。'],
    cab: ['人人核对已经通过，下一步是人车核对。', '前面的手续已完成，再核对车上显示的揭示信息。'],
    complete: ['本轮出勤流程已完成，可以回顾核对记录。', '核对时发现差异要报告，本轮练习已经结束。'],
  },
};

/** One shuffled bag per person/stage, so repeat conversations do not reset progress. */
export function createDialoguePicker(random: () => number = Math.random): (role: PersonRole, stage: TrainingStage) => string {
  const bags = new Map<string, string[]>(), lasts = new Map<string,string>();
  return (role,stage) => {
    const key = `${role}:${stage}`;
    let bag = bags.get(key);
    if (!bag?.length) {
      bag = [...stageDialogue[role][stage]];
      for(let i=bag.length-1;i>0;i--){const j=Math.floor(random()*(i+1));[bag[i],bag[j]]=[bag[j],bag[i]];}
      if (bag.length>1 && bag.at(-1)===lasts.get(key)) [bag[0],bag[bag.length-1]]=[bag[bag.length-1],bag[0]];
      bags.set(key,bag);
    }
    const text=bag.pop()!; lasts.set(key,text); return text;
  };
}
