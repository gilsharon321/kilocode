import { it } from "bun:test"
import { fixture } from "../fixtures/run"

it(
  "renders Cloud locations with explicit states, compound row identity and conflict handling",
  () => fixture("cloud-section"),
  30_000,
)
