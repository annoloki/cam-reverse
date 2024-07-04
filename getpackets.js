
var out=['{'], nt=1, tstr='\t\t\t\t\t\t';
const rx=/([0-9"\]]),"(_?data)":\["/;
function op(l) {
	if(l=='},' || l=='}') nt--;
	var ind=tstr.substr(0,nt);
	if(l.substr(-1)=='{') nt++;
	l=l.replace(/"(0x[a-f0-9]+)"/g,'$1');
	l=l.replace(/([{,])"([a-z_][a-z0-9]+|[0-9]+)":/gi,'$1$2:');
	if(l.length > 120) {
		if(l.match(/,_?data:\[/)) {
			l=l.replace(/,(data:\[[0-9a-fx,]+\]),?\}/gi,`,\n${ind}  $1\n${ind}}`);
			l=l.replace(/,_data:(\[[0-9,]+\]),/g,`,\n${ind}  decoded:$1,`);
		}
	}
	out.push(ind+l);
}
function rc() {
	let ol=out.length-1;
	out[ol]=out[ol].replace(/,$/,'');
}
for(let c1 in session.packets) {
	let c1p=session.packets[c1];
	op(c1+': {');
	for(let c2 in c1p) {
		op(c2+': '+JSON.stringify(c1p[c2])+',');
	}
	rc();
	op('},');
}
rc();
op('}');
str=out.join("\n");