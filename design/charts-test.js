var seed=7;function rnd(){seed=(seed*16807)%2147483647;return seed/2147483647}
function gen(n,start,p0){var rows=[],d=new Date(start),p=p0;while(rows.length<n){d.setUTCDate(d.getUTCDate()+1);var w=d.getUTCDay();if(w==0||w==6)continue;
 var o=p;if(rows.length==120)o=p*1.04;var c=o*(1+(rnd()-0.48)*0.03),h=Math.max(o,c)*(1+rnd()*0.01),l=Math.min(o,c)*(1-rnd()*0.01);
 rows.push([d.toISOString().slice(0,10),+o.toFixed(2),+h.toFixed(2),+l.toFixed(2),+c.toFixed(2),Math.round(200000+rnd()*3000000)]);p=c}return rows}
var D=gen(260,'2025-10-01',1280);window.D=D;
window.c={};
c.p1=TrendyCharts.price(document.getElementById('p1'),{data:D,title:'RELIANCE',subtitle:'NSE · EOD',prevClose:D[D.length-2][4],high52:Math.max.apply(null,D.map(r=>r[2])),low52:Math.min.apply(null,D.map(r=>r[3])),ma:{sma20:true}});
var pcr=[],oi=[];D.slice(-120).forEach((r,i)=>{pcr.push([r[0],0.8+0.3*Math.sin(i/9)+rnd()*0.05]);oi.push([r[0],9e6+i*5e4+rnd()*8e5])});
c.l1=TrendyCharts.line(document.getElementById('l1'),{title:'PCR trend',subtitle:'Nifty',ranges:['1M','3M','All'],baseline:1,series:[{name:'PCR',data:pcr,fill:true,format:v=>v.toFixed(2)}]});
c.l2=TrendyCharts.line(document.getElementById('l2'),{title:'PCR vs OI',series:[{name:'PCR',data:pcr,axis:'left',format:v=>v.toFixed(2)},{name:'Total OI',data:oi,axis:'right',color:'#f59e0b'}]});
var strikes=[],co=[],po=[];for(var s=23000,i=0;s<=26000;s+=100,i++){strikes.push(s);co.push(Math.round((s>24500?1:.3)*2e6*Math.exp(-Math.pow((s-24800)/600,2))+rnd()*2e5));po.push(Math.round((s<24500?1:.3)*3e6*Math.exp(-Math.pow((s-24200)/600,2))+rnd()*2e5))}
c.b1=TrendyCharts.bars(document.getElementById('b1'),{title:'OI by strike (31 strikes, scrolls)',categories:strikes,marker:24273.4,series:[{name:'Call OI',values:co},{name:'Put OI',values:po}]});
c.b2=TrendyCharts.bars(document.getElementById('b2'),{title:'OI by strike (15)',categories:strikes.slice(8,23),marker:24273.4,series:[{name:'Call OI',values:co.slice(8,23)},{name:'Put OI',values:po.slice(8,23)}]});
c.b3=TrendyCharts.bars(document.getElementById('b3'),{title:'Horizontal',orientation:'h',categories:strikes.slice(8,23),marker:24300,series:[{name:'Call OI',values:co.slice(8,23)},{name:'Put OI',values:po.slice(8,23)}]});
document.getElementById('live').innerHTML=TrendyCharts.liveEmbed(TrendyCharts.tvSymbol('stock','RELIANCE'));TrendyCharts.liveEmbedInit(document);
c.e1=TrendyCharts.price(document.getElementById('e1'),{title:'only closes',data:D.map(r=>[r[0],null,null,null,r[4],null])});
c.e2=TrendyCharts.price(document.getElementById('e2'),{title:'2 rows',data:D.slice(0,2)});
c.e3=TrendyCharts.price(document.getElementById('e3'),{title:'1 row',data:D.slice(0,1)});
c.e4=TrendyCharts.price(document.getElementById('e4'),{title:'NaN rows',data:[[NaN,1,2,3,4],['x',1,2,3,4,5],D[0],[D[1][0],NaN,NaN,NaN,NaN,1],D[2],D[3],D[3],null,D[4]]});
var big=gen(3000,'2013-01-01',500);
c.e5=TrendyCharts.price(document.getElementById('e5'),{title:'3000 rows',data:big,ranges:['1M','1Y','5Y','All'],range:'All'});
TrendyCharts.configure('k1',{data:D.slice(-80),title:'Auto'});
document.getElementById('auto').innerHTML='<div class="card"><div data-tc="price" data-tc-key="k1"></div></div>';
TrendyCharts.auto(document);
