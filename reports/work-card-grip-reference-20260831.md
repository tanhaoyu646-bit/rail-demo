# Work-card reference grip correction

## Scope

Use the user-approved work-card grip as the reference for the recorder, delivery paper and closed/open driver notebook. The thumb must remain complete and visible over the front, with the index behind the item. Do not hide the whole hand by rendering the item unconditionally in front.

## Measured baseline

`node tools/audit-work-card-grip.mjs` reads the exported GLBs and normalizes them exactly as the held-item loader does.

| Asset | Target height | Normalized width | Normalized depth |
|---|---:|---:|---:|
| work-card-lite.glb | 0.34 | 0.2260993943 | 0.0517569952 |
| driver-notebook-closed-lite.glb | 0.39 | 0.2682997763 | 0.0162822875 |
| recorder-lite.glb | 0.205 | 0.0951519635 | 0.0937255688 |

These are model-space measurements, not verified real-object physical dimensions. The recorder scan's bounding-box depth is not its front-face contact depth.

The accepted reference hand position is `(0.08, -0.10, 0.005)` with Z rotation `0.10`. Its card has right edge `0.1130496972`, bottom `-0.17`, and front contact surface approximately `0.025`.

## Correction

Each target hand position is derived by adding the target-minus-reference right-edge, bottom-edge and front-face offsets. The complete hand geometry and source node transforms remain unchanged. The opened notebook applies this transfer in its right page's folded coordinate frame.

The recorder surface recedes from Z `0.024235` at Y `-0.04` to Z `0.006971` at Y `0.01`. Its hand is rigidly aligned to this measured slope about the thumb contact. This keeps the index behind the recessed front without pushing the thumb through it.

Removed `prioritizeHeldObject` and all forced `depthTest=false` / `depthWrite=false` operations added by the previous revision. Paper, covers, underlines and recorder now use normal depth testing. No source GLB is overwritten and no hand geometry is removed or deformed.

## Validation

- Browser inspection: delivered paper at normal distance and raised close; closed notebook; opened notebook and raised close; recorder; existing work-card reference.
- Visible result in the inspected views: complete thumbnail and thumb over the front surface, item edge entering the grip, no blanket foreground mask cutting off the thumb.
- `test-uploaded-hand.mjs`: compares all 57,543 exported vertices in the reference/target contact frames, including the open-page fold and recorder slope. Maximum transfer error is below `3e-16` model units. Also rejects reintroducing the blanket depth override and verifies the original hand SHA-256 is unchanged.
- Build and regression tests passed: uploaded hand, reveal interaction, card insertion, breath interaction, nearby interaction, room/counter/doors, visual polish and training scenarios.
- Existing in-app browser `WrongDocumentError` pointer-lock warnings were observed during automated canvas clicks; not changed in this hand-grip revision. No claim is made that this static hand has articulated fingers or physically collision-free grasping from arbitrary external camera angles.

Source snapshot: `working/work-card-grip-reference-before/`.
