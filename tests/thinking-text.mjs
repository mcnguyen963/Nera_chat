import test from 'node:test';
import assert from 'node:assert/strict';
import {appHarness} from './app-harness.mjs';

test('thinking cleanup hides nested, attributed, orphaned and unfinished reasoning',async()=>{
 const {stripThinking}=await appHarness()('thinking-text.js');
 assert.equal(stripThinking('<think>a<think>b</think>c</think>V'),'V');
 assert.equal(stripThinking('<THINKING kind="private">hidden</THINKING> Answer'),'Answer');
 assert.equal(stripThinking('cot</think>Answer'),'Answer');
 assert.equal(stripThinking('cot</thinking>Answer'),'Answer');
 for(let i=1;i<='<thinking>'.length;i++)assert.equal(stripThinking('Visible '+'<thinking>'.slice(0,i)),'Visible','prefix '+i);
 assert.equal(stripThinking('Visible <think>unfinished'),'Visible');
 assert.equal(stripThinking('An ordinary answer'),'An ordinary answer');
});
