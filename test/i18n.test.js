'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),vm=require('node:vm');
const I=require('../lib/i18n');
const placeholders=s=>[...s.matchAll(/\{p\d+\}/g)].map(x=>x[0]).sort();
// \u542b\u6c49\u5b57\u7684\u8bed\u8a00\u8c41\u514d\u300c\u65e0 CJK\u300d\u68c0\u67e5:\u7e41\u4e2d\u672c\u8eab\u662f\u6c49\u5b57,\u65e5/\u97e9\u5728 UI \u7528\u8bed\u91cc\u4f1a\u7528\u5230\u6c49\u5b57\u8bcd
const CJK_LANGS=new Set(['zh-TW','ja','ko']);
test('locale catalogs cover every source key and preserve interpolation arguments',()=>{
 const source=I.catalogs['zh-CN'];
 for(const lang of ['en','tr','ja','ko','es','fr','de']){assert.deepEqual(Object.keys(I.catalogs[lang]).sort(),Object.keys(source).sort());for(const [key,value]of Object.entries(source)){assert.equal(typeof I.catalogs[lang][key],'string',key);assert.deepEqual(placeholders(I.catalogs[lang][key]),placeholders(value),lang+' '+key);if(!CJK_LANGS.has(lang))assert.doesNotMatch(I.catalogs[lang][key],/[\u3400-\u9fff]/,lang+' '+key);}}
});
test('traditional Chinese uses its own catalog and is not identical to simplified',()=>{
 const zhCN=I.catalogs['zh-CN'],zhTW=I.catalogs['zh-TW'];
 assert.deepEqual(Object.keys(zhTW).sort(),Object.keys(zhCN).sort());
 // \u7e41\u4e2d\u5fc5\u987b\u4e0e\u7b80\u4e2d\u4e0d\u540c,\u4e14\u4fdd\u7559\u5360\u4f4d\u7b26\u4e0e HTML \u7ed3\u6784
 const differing=Object.keys(zhCN).filter(k=>zhTW[k]!==zhCN[k]).length;
 assert.ok(differing>1000,'\u7e41\u4e2d\u5e94\u5927\u90e8\u5206\u6761\u76ee\u4e0e\u7b80\u4e2d\u4e0d\u540c,\u5b9e\u9645 '+differing);
 for(const [key,value]of Object.entries(zhCN)){assert.deepEqual(placeholders(zhTW[key]),placeholders(value),'zh-TW '+key);}
});
test('localized HTML templates retain their tags and executable attributes',()=>{
 for(const [key,source]of Object.entries(I.catalogs['zh-CN'])){if(!key.startsWith('ui.')||!/<[a-z]/i.test(source))continue;
 const tags=s=>[...s.matchAll(/<\/?[a-z][^>]*>/gi)].map(x=>x[0].replace(/(?:title|placeholder|aria-label)="[^"]*"/g,''));
 for(const lang of ['en','tr','ja','ko','es','fr','de'])assert.deepEqual(tags(I.catalogs[lang][key]),tags(source),lang+' '+key);
 }
});
test('preferences persist without changing other settings and reject invalid languages',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'toolkit-i18n-'));try{const pref=I.createPreferences(dir);assert.equal(pref.read(),'zh-CN');fs.writeFileSync(pref.file,JSON.stringify({extra:'keep'}));pref.write('tr');assert.equal(I.createPreferences(dir).read(),'tr');assert.equal(JSON.parse(fs.readFileSync(pref.file)).extra,'keep');assert.throws(()=>pref.write('../../secret'));assert.equal(pref.read(),'tr');pref.write('en');assert.equal(pref.read(),'en');}finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('response localization preserves user content and credentials',()=>{
 const key=Object.keys(I.catalogs['zh-CN']).find(k=>k.startsWith('message.')&&!/[<{]/.test(I.catalogs['zh-CN'][k])&&I.catalogs.tr[k]!==I.catalogs['zh-CN'][k]);
 const source=I.catalogs['zh-CN'][key];const input={msg:source,nickname:'设置',terms:['词库','设置'],password:'操作失败',path:'C:\\设置',user_id:'词库'};
 const result=I.localizeResponse(input,'tr');assert.equal(result.msg,I.catalogs.tr[key]);for(const field of ['nickname','terms','password','path','user_id'])assert.deepEqual(result[field],input[field]);assert.deepEqual(input.nickname,'设置');
});
test('page bootstrap is safe to embed and browser translations use English fallback',()=>{
 assert.equal(I.safeJSON({value:'</script>\u2028'}).includes('</script>'),false);
 const window={__TOOLKIT_I18N__:{language:'tr',messages:{},english:{greet:'Hello {p0}'},source:{}}};vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../assets/i18n.js'),'utf8'),{window});assert.equal(window.ToolkitI18n.t('greet','',["设置"]),'Hello 设置');
 const page=I.renderPage('<html lang="zh-CN"><script>window.__TOOLKIT_I18N__=__I18N_BOOTSTRAP__;</script>', 'tr');assert.match(page,/<html lang="tr">/);assert.equal([...page.matchAll(/<\/script>/g)].length,1);assert.equal(page.split('<script>')[1].split('</script>')[1],'');new vm.Script(page.match(/<script>([\s\S]*)<\/script>/)[1]);
});
