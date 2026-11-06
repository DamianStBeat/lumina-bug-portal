# A removal that survives a reload (bp-integration stage 3a)

Closes row 10 and three findings: Astra queue.ts:202/:227 (a queued Remove forgotten when the page is left), Astra
queue.ts:309-314 (a failed cleanup of a late create loses the attachment), Opus queue.ts:153/:463 (a failed row turns
neutral while its DELETE is out). The rule: **a Remove is written to the session in the transition where it is
pressed**, saved before any request it causes, in every step; it leaves the session only when the server says the
attachment is gone. A reload is a dead tab: only sessionStorage survives.

## 1. What is persisted (session.ts)

Scope: a saved removal lives in a `Session`, so it belongs to its `code` and is deleted with its `reportToken`. `v: 3`
stays: one tab runs one build, and the additions are optional fields.

- `removing: true` on a line **with** an attachment: as today (attachmentId, partSize, partCount), but written when
  Remove is pressed (in `apply` 'remove'), no longer when its turn comes (`drop`). Steps: picked with an attachment,
  uploading, completing, paused, failed, unremoved.
- `removing: true` on a line **without** an attachment (new: `{ attachmentId: null, done: false, removing: true }`):
  Remove pressed while its create is out. The open line is flipped, not dropped (today queue.ts:202 drops it), so the
  create answering later finds where to write its id. `isSavedFile` accepts it; `done: true` with it stays invalid.
- `pending?: { name: string; size: number }[]` on the Session (new): Remove pressed while a re-picked file is being
  hashed, named the only way known before the hash. Written only when a saved line, not done and not removing, has
  that name and size (else nothing is on the server).

Cleared when: the DELETE answers gone, which is `2xx { ok: true }` or `404` (useUpload.ts `gone`). Read in
worker/src/routes/uploads.ts `remove`: DELETE answers 200 `{ ok: true }` for an uploading, complete, aborted or already
deleted row, and 404 `not_found` when no row exists. **DELETE never answers 409**: `409 not_uploading` comes only from
PUT part and complete, so it is not a "gone" code here. Anything else (401 `invalid_token`, 5xx, network, 502
`bad_answer`) keeps the removal: the attachment may still hold one of the 3 places. A `pending` entry is cleared when
its hash answers on this page (resolved to the exact line, below) or when the next load turns it into marks.

## 2. Replay on the next load

The `mount` event, the first one of a load, does in one transition (one save), before any pick or Send can run:
1. `pending`: every saved line with that name and size, not done and not removing, is struck: one with an attachment
   gets `removing: true`, one without is dropped. `pending` is removed.
2. Lines `removing` without an attachment are dropped: their create died with the old tab, its id unknowable (no
   player route lists attachments; the known limit of queue.ts:216-218).
3. Every line `removing` with an attachment gets one DELETE `by: { k: 'load' }` (as today). New: the Send waits (in
   `run`) while a load DELETE is out (`State.loading: string[]`, ids sent by mount, removed when each answers), so no
   create or resume starts before the places are known. Picks are still taken; they count the marked lines as held.
4. Gone: the line is dropped (as today). Not gone: the line stays marked, its id goes to `failed`, the place stays
   counted by `heldBy`, a pick that needs it sends it again (`held`, as today), and the next load sends it again.
- A marked line never binds (`bind`, `plan`, `resumeOf` skip it), so a re-picked match is not resumed nor asked for;
  picked again it is a new file with a new attachment (queue.ts:387). The orange "unremoved" line needs a listed row:
  after a reload the file is not listed (no File), so a failed load DELETE shows nothing (doubt in the done file).

## 3. Create answering after removal or unmount (finding queue.ts:309)

- Same epoch (`created`, removed or queued): the id goes **into the existing id-less removing line** (matched by name,
  size, head), which keeps `removing: true`; append only when none is found. Then the DELETE goes now or at its turn.
- Old epoch (`leftCreated`): instead of a bare DELETE it emits `{ t: 'adopt', code, token, line }` (line marked, with
  the id). useUpload.ts keeps one module-level `owner`: the mounted machine (set on mount, cleared on closed if it is
  still that machine). With an owner, the hook dispatches `{ t: 'adopt', ... }` to it: if its session has the same
  code and reportToken (or is null, then a session with only that line is made, as `run` does at queue.ts:488), the
  line is written (or its id-less twin filled) and a DELETE `by: 'load'` goes under the owner's epoch, so its failure
  is kept in `failed` and the place held. Without an owner, the hook writes the line into storage (read, check code
  and token, or empty storage, write) and sends the DELETE `by: 'left'`; its answer changes nothing, and the next load
  sends it again (one extra DELETE, answered 200 since DELETE is idempotent). If the stored or owned session is
  another report's, nothing is written (row 2) and the DELETE still goes, untracked (known limit: one storage key).
- The gap between the boot read (`useState`) and the mount effect: the `mount` event carries `stored: loadSession()`
  (filtered by `only`) and adopts marked lines of the same code and token missing from the state's session.

## 4. Row colour while removing (finding queue.ts:153/:463)

`Item.was?: Step`: the step a file had when Remove was pressed (set in `apply` 'remove', kept by `drop`). While
`step === 'removing'`, `viewState` answers for `was` (failed stays `refused` or `error`, `why` kept, so useUpload.ts
`refused` keeps the refusal line); `unremoved(s)` also counts a removing file whose `was` is `unremoved`, so the
orange line stays during the retry. Only the DELETE's answer changes the row: gone → leaves, not gone → unremoved.

## 5. Stale answers

Unchanged: a remove DELETE answer needs key, generation (moved by `drop`), epoch and attachment id (queue.ts:316);
a load or held answer the epoch and a marked line with that id; a hash answer key, generation and epoch, so an old
hash never resolves nor clears a `pending` entry. New: an `adopt` is a server fact keyed by attachmentId, applied only
to a session of the same code and reportToken, never by epoch; a `left` DELETE answer stays dropped. Row 2 of
queue-races.spec.ts holds: the old page's DELETE and hash answers are of an old epoch, the new page (`OTHER`) ignores
a `stored` or `adopt` of `CODE`, and nothing is written for `CODE` once `OTHER`'s session is stored.

## 6. State table

| Step at Remove | Saved at press (before any request) | Row shows until the DELETE answers | Reload before the answer |
|---|---|---|---|
| hashing (bind job, re-picked saved file) | `pending { name, size }`; when the hash answers here: the matched line marked and `pending` cleared in one save | waiting (as before) | name+size lines struck; marked ones get one DELETE; not resumed, not asked for |
| creating (create out, no id) | open line → `{ attachmentId: null, removing: true }`; id filled when the create answers | waiting (as before) | id-less line dropped; a create answered meanwhile (same JS) was adopted with its id |
| uploading / completing | line `removing: true` (upload aborted after the save) | uploading, bar frozen | one DELETE on mount; not resumed |
| paused | line `removing: true` | uploading (as paused shows) | one DELETE on mount; not resumed |
| failed, with an attachment | line `removing: true` | refused (red, refusal line) or error | one DELETE on mount; not resumed |
| failed, no attachment | line dropped (nothing on the server) | leaves at once | nothing |

## 7. Specs to write (hook level: FakeServer, installStorage, mount/unmount as queue-races.spec.ts)

1. Row 10: `savedHalfWay` → mount, `holdDigest`, re-pick clip, Remove while hashing, unmount → mount again: exactly one
   DELETE of the clip's attachment at mount; after 200 no clip line saved, `resume` null, the fake's row `aborted`.
2. Row 10, transient: as 1, DELETE answers 503 on the second load → line still marked; 3 new small files picked → 2
   listed, rejection `count`; third load with no fault → DELETE again, line gone.
3. Row 10, the hash answers on this page: one save marks the line, drops `pending`; one DELETE; no DELETE on reload.
4. Astra :202/:227: a file with an attachment whose Remove waits behind another file's held DELETE; storage marks it
   before any answer; unmount → next mount DELETEs it, re-picking it does not resume it (no PUT to its id).
5. Astra :309: Remove while the create is held, unmount, create answers, DELETE 503 → storage holds the marked line
   with that id; reopen → DELETE sent again and 3 picks list only 2 until it answers 200.
6. Same as 5 with a page of the same report mounted when the create answers: its session gets the line, it sends the
   DELETE, 503 keeps it in `failed` and the place counted.
7. Remove while the create is held, then a reload (the create never answers): next mount sends no DELETE, saves no
   id-less line, `resume` does not ask for the file.
8. Opus :153/:463: a refused file (PUT part 400) with its DELETE held → after Remove the row is still `refused` and
   `refused` (why) unchanged; 200 → it leaves; 503 → unremoved and the orange line.
9. Row 2 still holds (existing specs untouched) plus: an `adopt` for `CODE` while `OTHER` is mounted leaves
   `loadSession()` equal to `OTHER`'s and its upload finishes.
10. Send waits for the load DELETE: a marked line and a re-picked saved file; the mount DELETE held → Send pressed →
    no create and no PUT until it answers.

## 8. Files and budget (source only, specs are the test author's)

- session.ts (~15): `SavedFile` id-less branch with `removing?: true`, `Session.pending?`, `isSavedFile`/`isSession`.
- queue.ts (~170): `apply` 'remove' (mark, flip or pending at press, `was`), 'mount' (stored, pending, id-less drop,
  `loading`), 'created' (fill id), `leftCreated` (adopt effect), new 'adopt' event, `bind` (resolve pending), `drop`
  (mark idempotent), `deleted` (`loading`), `run` (wait on `loading`), `viewState`, `unremoved`, and a `struck(f)`
  beside `marked(f)` used by `lineOf`, `heldBy`, `resumeOf`, `bind`, `plan`, `begin`.
- useUpload.ts (~40): `owner`, the `adopt` runner (dispatch or storage write plus DELETE), `mount` with `stored`.
  Total about 225 lines, under the 400 of one slice.
