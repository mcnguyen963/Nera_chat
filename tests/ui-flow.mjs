import test from 'node:test';
import assert from 'node:assert/strict';
import {appHarness} from './app-harness.mjs';
const {settingsVisibility,applySettingsVisibility}=await appHarness()('ui/settings-visibility.js');

for(const mode of ['classic','director'])for(const lorebooks of [false,true])for(const autoUpdate of [false,true]){
 test(`Settings show only ${mode} instructions with lore=${lorebooks}, updates=${autoUpdate}`,()=>{
  const flags=settingsVisibility({mode,memory:{lorebooks,autoUpdate}});
  assert.equal(flags.classic,mode==='classic');assert.equal(flags.director,mode==='director');
  assert.equal(flags.memoryPrompts,lorebooks||autoUpdate);
  assert.equal(flags.lore,lorebooks);assert.equal(flags.autoUpdate,autoUpdate);
 });
}
test('Keyword recall does not require an embedding connection; either semantic consumer does',()=>{
 assert.equal(settingsVisibility({memory:{historyRecall:true,semanticRecall:false}}).embeddings,false);
 assert.equal(settingsVisibility({memory:{historyRecall:true,semanticRecall:true}}).embeddings,true);
 assert.equal(settingsVisibility({memory:{lorebooks:true,semanticLore:true}}).embeddings,true);
 const retained=settingsVisibility({memory:{lorebooks:false,autoUpdate:false,semanticLore:true}});
 assert.equal(retained.embeddings,true);assert.equal(retained.semanticControl,true);
 assert.equal(settingsVisibility({memory:{lorebooks:false,autoUpdate:false,semanticLore:false}}).semanticControl,false);
});
test('Book budgets follow book selection and automatic updates retain book selection without reply lore',()=>{
 const flags=settingsVisibility({memory:{lorebooks:true,books:{characters:{on:false},locations:{on:true}}}});
 assert.equal(flags['book-characters'],false);assert.equal(flags['book-locations'],true);
 const updatesOnly=settingsVisibility({memory:{autoUpdate:true,lorebooks:false}});
 assert.equal(updatesOnly.memoryPrompts,true);assert.equal(updatesOnly['book-characters'],false);
});
test('Provider-specific controls do not appear for lookalike hosts',()=>{
 assert.equal(settingsVisibility({endpoint:'https://openrouter.ai/api/v1/chat/completions'}).openRouter,true);
 for(const endpoint of ['https://example.test/v1','https://openrouter.ai.example.test/v1','https://example.test/openrouter.ai'])assert.equal(settingsVisibility({endpoint}).openRouter,false);
});
test('Visibility changes preserve editable nodes, draft text, selection and invalid-field review',()=>{
 const textarea={value:'Unsaved custom Director instructions',selectionStart:8,selectionEnd:14};
 const group={dataset:{settingsWhen:'director'},hidden:false,textarea};
 const root={querySelectorAll:()=>[group]};
 applySettingsVisibility(root,settingsVisibility({mode:'classic'}));assert.equal(group.hidden,true);
 applySettingsVisibility(root,settingsVisibility({mode:'director'}));assert.equal(group.hidden,false);
 assert.equal(group.textarea,textarea);assert.equal(textarea.value,'Unsaved custom Director instructions');assert.equal(textarea.selectionStart,8);assert.equal(textarea.selectionEnd,14);
 group.dataset.settingsReview='true';applySettingsVisibility(root,settingsVisibility({mode:'classic'}));assert.equal(group.hidden,false);
 delete group.dataset.settingsReview;applySettingsVisibility(root,settingsVisibility({mode:'classic'}));assert.equal(group.hidden,true);
});
