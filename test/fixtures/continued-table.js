// Independent fixture intent: three retained header occurrences, then a separate
// table with identical labels. Page 2 restarts row numbering; page 3 uses global rows.
export function continuedTableFixture() {
  const nodes = [], headers = {}, repeats = {};
  for (let page=1; page<=4; page++) {
    const id = name => `p${page}-${name}`, tableId = page===4?"separate":"continued";
    const add = (name,role,text,row,col,extra={},targets=[]) => {
      const sourceRow = page===3?row+8:row;
      const y = row===3?680:row===2?620:(page===1?530:80)+row*36;
      nodes.push({id:id(name),sourceBlockId:id(name),pageNumber:page,role,text,textProvenance:"native",confidence:1,
        bbox:[50+col*150,y,140,14],tableId,tableRowIndex:sourceRow,tableColumnIndex:col,...extra});
      headers[id(name)] = targets.map(id);
      if(page===2||page===3)if(role==="TH"&&row<2)repeats[id(name)]=`p1-${name}`;
    };
    add("region","TH","Region",0,0,{tableRowSpan:2,tableSection:"head"});
    add("volume","TH","Volume",0,1,{tableColumnSpan:2,tableSection:"head"});
    add("count","TH","Count",1,1,{tableSection:"head"},["volume"]);
    add("rate","TH","Rate",1,2,{tableSection:"head"},["volume"]);
    add("north","TH",`North ${page}`,2,0,{scope:"Row"},["region"]);
    add("n1","TD",`${page}00`,2,1,{},["count","volume","north"]);
    add("n2","TD",`${page}20`,2,2,{},["rate","volume","north"]);
    add("south","TH",`South ${page}`,3,0,{scope:"Row"},["region"]);
    add("s1","TD",`${page}10`,3,1,{},["count","volume","south"]);
    add("s2","TD",`${page}30`,3,2,{},["rate","volume","south"]);
  }
  return {nodes,headers,repeats};
}
