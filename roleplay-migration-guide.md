# Move an ongoing roleplay to the new system

You can keep playing the same story. You do not need to start over or rewrite old messages.

## 1. Make a safe copy

1. Wait for any reply or memory update to finish.
2. Open **Settings → Import & export → Export current story** and save the `.jsonl` file.
3. In **Sessions**, copy the whole story and open the copy. Keep the original as your backup.

The story export includes messages, saved summaries, your plan, memory settings, and lorebooks. Your model settings and custom prompts are shared account settings, so save any custom versions separately before changing them.

## 2. Set the new prompts and model

In **Settings**, use **Reset to app default** on each prompt you want to update: narrator, summarizer, memory update, and reorganize. Reapply any custom instructions you still need.

Set the model to:

```text
z-ai/glm-5.3-flash:floor
```

Keep `:floor` at the end. Save your settings.

## 3. Turn on scene and memory

Open **Settings → Memory** for your copied story:

- Enter the protagonist's full name.
- Turn on **Scene line**, **Show the scene under replies**, **Use lorebooks in replies**, and **Memory block near the end**.
- Leave **Automatic memory updates** off for now.

If you already have character, location, or world notes, add or import them in **Lorebooks**. Check names and facts before using them. Keep future plans in your plan; record only events that have actually happened in the event timeline.

## 4. Set where the story is now

Find the latest story reply (skip any OOC messages). Click its scene line, or **+ Add scene**, and enter the current date, time, place, and people physically present. Use exact character names. If you do not know the date or time, enter `unknown`. Do not include people who have left or are outside.

This is the key step for an ongoing story. **Starting scene** is for the beginning of the story; it does not replace later scenes.

## 5. Choose whether to build memory from old messages

If your lorebooks already cover the earlier story, turn on **Automatic memory updates** and choose **From now on** when asked.

If you want the app to make notes from the old story, choose **From the beginning**, then use **Catch up…**. Review the notes it creates. This can use many model calls, so review the estimate before starting.

Keep your existing summary checkpoint unless it is wrong. Summaries keep older conversation available in compressed form; lorebooks store useful facts and events. You usually do not need to summarize everything again.

## 6. Check the copy, then continue

Open **⋯ → Context details**. Confirm the current place and present characters load, and that your plan and recent messages are included.

You can send this short OOC check:

```text
<OOC>Where are we, and who is physically present? Do not advance the story. Say unknown if the time is unclear.</OOC>
```

If the answer matches your scene, continue playing in the copy. If something is wrong, edit the scene or return to your original story.

Narrative replies are intended to be 200–600 words. The model may still make mistakes, so review its replies before accepting invented player actions or story facts.
