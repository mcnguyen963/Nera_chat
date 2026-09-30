# Reviewed author note for migrating an ongoing roleplay

This is a template for **Settings → This story → Create continuity copy of this
story → Reviewed author note**. The field needs the story's actual current state.
Fill the template from your transcript, check it, then paste the completed note.

To have another LLM draft the note, give it
[the transcript extraction prompt](migration-transcript.md) together with your
JSON/JSONL transcript. Review its result before using it as author canon.

## Before pasting

- Replace every bracketed placeholder. Remove empty optional sections and any
  facts that do not apply. Do not paste an unfinished template.
- Include consequential absent characters, not just whoever is in the current
  scene. Their relationships and obligations may matter when they return.
- Keep established knowledge when the learning method is unspecified. “A knows
  this; how A learned it is unspecified” is different from “It is unknown whether
  A knows this.” Neither permits inventing a disclosure scene.
- Distinguish unavailable information from an established absence. “No evidence
  of forgiveness in the supplied transcript” does not prove that forgiveness
  never occurred if the transcript is incomplete.
- Resolve important contradictions yourself or explicitly leave the disputed
  fact unknown. Do not approve two incompatible assertions as current canon.
- Use readable names consistently. You do not need to make application record
  IDs, source hashes, JSON patches, or tool instructions.
- Add short real source references where helpful. The app uses the reviewed note
  itself as its author source; it does not independently verify every reference
  against your entire old transcript. Keep those references accurate.
- Put your writing preferences in **Continuity prose preferences**. This note
  establishes story state and author directions.

## Copy and fill this note

Copy only the completed text inside the following block into the field.

```text
MIGRATION AUTHOR NOTE

This note establishes the current canon for this story at the migration point.
It describes already established facts and explicitly identified author directions.
It does not advance fictional time, complete pending actions, or authorize new
player actions. Unspecified facts remain unknown. Possible futures are separate
from played events and character knowledge.

1. CONTINUITY AND COVERAGE

Story or continuity: [name or description]
Migration point: [last accepted exchange or other unambiguous stopping point]
Source coverage: [complete transcript, or describe the known gaps]
Active branch: [identify the chosen version if edits/regenerations produced alternatives]

Important author decisions concerning contradictions:
[State the selected canon or explicitly identify what remains unknown.
Do not combine mutually exclusive versions of the story.]

2. CURRENT SCENE

Location: [...]
Fictional time and relevant deadline, if established: [...]
Present characters: [...]
Relevant positions and nearby characters: [...]
Immediate situation or conflict: [...]
Latest established action or exchange: [...]
Pending question, offer, attempt, threat, or unresolved outcome: [...]
Next unresolved player decision: [...]

Relevant injuries, exhaustion, restraints, ongoing effects, resources, and items:
[Include possession/ownership and limitations only where established.]

An unresolved player attempt is still an attempt. An offer is still an offer.
Do not assume the player's response or finish the scene as part of migration.

3. PLAYER CHARACTER

Name and aliases: [...]
Established identity, background, and stable traits: [...]
Capabilities and important limits: [...]
Current physical condition and situation: [...]
Current emotions or beliefs explicitly supplied by the player: [...]
Goals and intentions explicitly supplied by the player: [...]
Explicit existing commitments: [...]

The user controls this character's voluntary actions, dialogue, thoughts,
emotions, consent, and decisions. NPC interpretations do not establish the
player's actual inner state. No additional authority to control the player
is granted by this migration note.

4. OTHER CHARACTERS

[Repeat this entry for each important character. Use a shorter entry for a minor
character. Include important absent, deceased, or missing characters when their
identity, experiences, or relationships still affect the story.]

Name and aliases: [...]
Role and current whereabouts, if established: [...]
Stable personality and values: [...]
Established background: [...]
Voice and characteristic manner of speaking: [...]
Current emotion or mood: [...]
Current physical condition and situation: [...]
Current goals: [...]
Current intentions or immediate approach: [...]
Significant experiences shaping current behavior: [...]
Relevant capability limits or restrictions: [...]
Source references or explicit uncertainty: [...]

Stable personality shapes how current state is expressed. It does not erase
relationship history or lasting consequences. A temporary mood does not by
itself redefine personality, trust, affection, hostility, or loyalty.

5. DIRECTIONAL RELATIONSHIPS

[Repeat for each significant established direction. A toward B and B toward A
can differ. Do not invent the reverse direction when it is not established.]

From: [character]
Toward: [character]
Current trust and its limits: [...]
Current affection, attachment, or absence of established affection: [...]
Current hostility, resentment, or conflict: [...]
Boundaries and conditions for contact or cooperation: [...]
Practical cooperation, dependency, or power imbalance: [...]
Important turning points and what each actually changed: [...]
Any established reconciliation, forgiveness, or change of loyalty: [...]
Remaining unresolved issues: [...]
Source references or explicit uncertainty: [...]

Politeness, temporary calm, fear, attraction, obedience, and practical cooperation
are distinct from trust and forgiveness. Describe the actual dimensions that
changed. Do not turn an isolated friendly gesture into a complete reset.

6. CONTINUING CONSEQUENCES AND COMMITMENTS

[Repeat for each significant grievance, promise, loyalty, conflict, injury, debt,
or obligation. Keep causes and current status clear.]

Type: [...]
Holder or obligated character: [...]
Target, beneficiary, or other involved character: [...]
Triggering event or explicit commitment: [...]
What remains consequential now: [...]
Status: [open or resolved, according to established facts]
Remaining obligation, boundary, or unresolved dispute: [...]
Existing deadline or condition, if established: [...]
Resolution event, if actually resolved: [...]
Source references or explicit uncertainty: [...]

Open consequences remain open when later dialogue does not mention them.
Elapsed time, a greeting, an apology, or shared danger does not automatically
resolve them. Record partial progress separately from full resolution.

7. KNOWLEDGE, BELIEFS, AND SECRETS

[Repeat for each consequential fact or claim and each relevant holder.
Distinguish the underlying world fact from the character's perspective.]

Proposition or claim: [...]
World truth: [established true, established false, or unresolved]
Holder: [character]
Holder's stance: [knows, believes, suspects, denies, or unknown]
How or when the holder acquired it: [established mechanism, or explicitly unspecified]
What the holder actually learned and what remains uncertain: [...]
Characters explicitly established not to know: [...]
Characters whose awareness is simply not established: [...]
Relevant source references: [...]

Knowing that an accusation was made does not establish its truth. A character
who saw a result may not know its unseen cause. Private thoughts, restricted
information, and other characters' experiences do not automatically become
shared knowledge. Do not invent a witness, confession, letter, or disclosure.

8. ESSENTIAL ESTABLISHED HISTORY

[Use a lean chronological or causally ordered list. Preserve events that explain
current relationships, knowledge, obligations, injuries, possessions, or stakes.]

Event: [...]
What actually happened, or what was merely reported: [...]
Involved characters: [...]
Consequences still relevant at the stopping point: [...]
Source reference: [...]

9. ESSENTIAL WORLD FACTS AND RULES

[Include only established setting facts needed to continue: important factions,
authority, geography, social rules, powers and their limits, ownership, contracts,
deadlines, or resources. Do not invent missing mechanics or quantities.]

Fact or rule: [...]
Relevant characters or institutions: [...]
Known limits or exceptions: [...]
Public or restricted information: [...]
Who actually knows it, if consequential: [...]
Source reference or uncertainty: [...]

Public availability is not proof that every character has learned a fact.

10. AUTHOR CORRECTIONS AND CURRENT CANON

[Omit this section if there are no relevant corrections.]

Earlier assertion: [...]
Explicit correction and its scope: [...]
Type: [author retcon, or an in-story discovery changing someone's belief]
Resulting current world fact: [...]
Affected relationships, consequences, or other state: [...]
Which characters know the corrected fact: [...]
Which characters retain an earlier or mistaken belief: [...]
Source of the correction: [...]

A correction to world truth does not automatically tell a character about it.
An in-story discovery adds history; it does not erase the earlier experience.

11. FUTURE DIRECTIONS — NOT YET OCCURRED

[Omit if no future directions are established. Keep author directions separate
from character goals already listed above.]

Author direction or desired possibility: [...]
Involved characters: [...]
Established prerequisites: [...]
Plausible opportunity, if already identified: [...]
Current availability or obstacle: [...]
Choices that have delayed, changed, or prevented it: [...]
Source of the author direction: [...]

These are possible futures. They do not establish events, knowledge, consent,
relationships, or the player's participation. Honor choices that change the arc.

12. CONTINUATION POINT

Resume from: [brief exact situation at the end of the accepted transcript]
The following remains pending: [...]
The narrator may portray supported NPC/world responses while leaving the
player's next meaningful choice open. Do not replay completed events or skip
ahead to a planned outcome.
```

## Worked example: cheerful baseline and an unresolved grievance

This is an illustration, not assumed canon for your story. Include it only if
these facts have actually been established or you explicitly choose them as author
setup. A migration note still needs your real current scene and continuation point.

```text
A is normally cheerful and friendly. Those are stable personality traits.
The player killed A's mother. This is established as a world fact.
A knows the player did it. Her method of learning is unspecified; no learning
scene is invented by this note.

A currently deeply distrusts the player. A has an open grievance against the
player over her mother's death. No reconciliation or forgiveness has been
established in this continuity. Her precise immediate mood is unspecified.

A's baseline cheerfulness does not restore trust. Politeness or cooperation
for a concrete reason would not by itself resolve the grievance. No revenge
goal, attack, romantic feeling, or other intention is established by this note.
The player's feelings toward A are not specified.
```

## Save it and use it once per migration

Keep a copy of the filled note alongside a transcript export. The template can be
reused, but each migrated story needs its own current facts.

1. Paste the completed note into **Reviewed author note**.
2. Click **Review migration state** and inspect the proposed records and events.
3. Correct the note and preview again if anything is wrong.
4. Select **Reviewed** or **Saver**, then click **Create continuity copy**.

Preview prepares the state; creating the copy saves the note and initializes the
new story with the preserved transcript. The original story stays intact. This is
a snapshot of the transcript loaded for preview; subsequent changes to the old
story do not synchronize into the copy.

Do not paste the migration note every turn. The new system manages state after
migration. Later author corrections belong in **Author note** beside the composer
or **Edit character and story state** in Settings. If you migrate a different
story or a later snapshot, review a new note for that specific continuation point.
