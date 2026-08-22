import { useMemo, useState } from "react";
import { createSeededRng, generateAdaptiveSession, SKILL_CATALOG, type SkillDefinition, type SkillDomain } from "@noteforge/trainer-core";
import { useLab, type ViewId } from "@/state/LabContext";
import { pitchClassLabel } from "@/lib/music-display";
import { ActionButton, Eyebrow, Panel, Segmented } from "@/ui/Controls";
import { Icon } from "@/ui/Icon";

const domains: { id: SkillDomain | "all"; label: string; color: string }[] = [
  { id: "all", label: "Whole graph", color: "cream" }, { id: "perception", label: "Perception", color: "blue" },
  { id: "production", label: "Production", color: "coral" }, { id: "symbolic", label: "Symbolic", color: "lime" },
  { id: "spatial", label: "Spatial", color: "violet" }
];

const tagToView: [string, ViewId][] = [
  ["hum", "hum"],
  ["chord", "harmony"], ["harmony", "harmony"], ["melody", "melody"], ["phrase", "melody"], ["interval", "intervals"],
  ["dynamics", "control"], ["hold", "control"], ["production", "mirror"], ["absolute", "ear"], ["pitch-class", "ear"]
];

function skillView(skill: SkillDefinition): ViewId {
  for (const [tag, view] of tagToView) if (skill.skillId.includes(tag) || skill.tags.includes(tag)) return view;
  return skill.domain === "production" ? "mirror" : "sound";
}

function domainIcon(domain: SkillDomain): Parameters<typeof Icon>[0]["name"] {
  return domain === "perception" ? "ear" : domain === "production" ? "mic" : domain === "symbolic" ? "skills" : "sound";
}

export function SkillMap() {
  const { setView } = useLab();
  const [domain, setDomain] = useState<SkillDomain | "all">("all");
  const [selectedId, setSelectedId] = useState(SKILL_CATALOG[0].skillId);
  const [sessionSeed, setSessionSeed] = useState(20260822);
  const selected = SKILL_CATALOG.find((item) => item.skillId === selectedId) ?? SKILL_CATALOG[0];
  const filtered = domain === "all" ? SKILL_CATALOG : SKILL_CATALOG.filter((item) => item.domain === domain);
  const byDomain = useMemo(() => domains.slice(1).map((item) => ({ ...item, skills: SKILL_CATALOG.filter((skill) => skill.domain === item.id) })), []);
  const session = useMemo(() => generateAdaptiveSession(SKILL_CATALOG, {}, { sessionSize: 10, rng: createSeededRng(sessionSeed), respectPrerequisites: false }), [sessionSeed]);

  return (
    <div className="page skills-page">
      <div className="lab-intro"><div><Eyebrow>No lessons · no global grade</Eyebrow><h1>A graph of trainable primitives.</h1><p>Every attempt strengthens a specific edge between heard sound, vocal mechanics, musical label, harmonic function, and instrument space.</p></div><ActionButton className="primary" onClick={() => setSessionSeed((seed) => seed + 1)}><Icon name="spark" size={17} /> Generate session</ActionButton></div>

      <Panel className="representation-map">
        <div className="rep-center"><span className="brand-mark">N<span /></span><small>ONE NAVIGABLE</small><strong>PITCH OBJECT</strong></div>
        {[{ label: "HEARD SOUND", icon: "ear", className: "heard" }, { label: "VOCAL MECHANICS", icon: "mic", className: "motor" }, { label: "MUSICAL LABEL", icon: "skills", className: "label" }, { label: "HARMONIC FUNCTION", icon: "harmony", className: "function" }, { label: "INSTRUMENT SPACE", icon: "sound", className: "space" }].map((item) => <div key={item.label} className={`rep-node ${item.className}`}><Icon name={item.icon as Parameters<typeof Icon>[0]["name"]} size={21} /><span>{item.label}</span></div>)}
        <svg viewBox="0 0 1000 260" preserveAspectRatio="none" aria-hidden="true"><path d="M500 130L120 55M500 130L290 220M500 130L710 220M500 130L880 55M500 130L500 18" /></svg>
      </Panel>

      <div className="skill-layout">
        <Panel className="graph-panel">
          <div className="panel-heading"><div><Eyebrow>{SKILL_CATALOG.length} connected primitives</Eyebrow><h2>Complete skill graph</h2></div><span className="graph-legend"><i className="foundation" /> foundation <i className="advanced" /> later edge</span></div>
          <Segmented value={domain} onChange={setDomain} options={domains.map((item) => ({ value: item.id, label: item.label }))} />
          {domain === "all" ? <div className="domain-columns">{byDomain.map((group) => <div key={group.id} className={`domain-column ${group.color}`}><div className="domain-column-head"><Icon name={domainIcon(group.id as SkillDomain)} size={19} /><span>{group.label}</span><b>{group.skills.length}</b></div>{group.skills.map((skill, index) => <button key={skill.skillId} className={`${selectedId === skill.skillId ? "selected" : ""} ${skill.prerequisites.length === 0 ? "foundation" : ""}`} onClick={() => setSelectedId(skill.skillId)}><i style={{ opacity: .25 + skill.difficulty * .75 }} /><span><b>{skill.label}</b><small>{skill.skillId}</small></span>{index < group.skills.length - 1 && <em />}</button>)}</div>)}</div> : <div className="filtered-skill-grid">{filtered.map((skill) => <button key={skill.skillId} className={selectedId === skill.skillId ? "selected" : ""} onClick={() => setSelectedId(skill.skillId)}><span className={`skill-difficulty d-${Math.round(skill.difficulty * 4)}`}><Icon name={domainIcon(skill.domain)} size={20} /></span><span><b>{skill.label}</b><small>{skill.description}</small></span><em>{Math.round(skill.difficulty * 100)}</em></button>)}</div>}
        </Panel>

        <div className="skill-side">
          <Panel className="skill-detail-card">
            <div className={`skill-detail-icon ${selected.domain}`}><Icon name={domainIcon(selected.domain)} size={25} /></div><Eyebrow>{selected.domain} · difficulty {Math.round(selected.difficulty * 100)}</Eyebrow><h2>{selected.label}</h2><code>{selected.skillId}</code><p>{selected.description}</p><div className="representation-tags">{selected.representations.map((item) => <span key={item}>{item.replaceAll("-", " ")}</span>)}</div><dl><div><dt>Prerequisites</dt><dd>{selected.prerequisites.length || "none"}</dd></div><div><dt>Tags</dt><dd>{selected.tags.length}</dd></div><div><dt>Status</dt><dd>unmeasured</dd></div></dl>{selected.prerequisites.length > 0 && <div className="prerequisite-list"><span>CONNECTED FROM</span>{selected.prerequisites.map((id) => <button key={id} onClick={() => setSelectedId(id)}>{SKILL_CATALOG.find((skill) => skill.skillId === id)?.label ?? id}<Icon name="arrow" size={13} /></button>)}</div>}<ActionButton className="wide primary" onClick={() => setView(skillView(selected))}>Open connected laboratory <Icon name="arrow" size={16} /></ActionButton>
          </Panel>

          <Panel className="adaptive-mix-card"><Eyebrow>Session engine</Eyebrow><h2>60 / 20 / 20</h2><div className="mix-bar"><span style={{ width: "60%" }}>WEAK / DUE</span><span style={{ width: "20%" }}>RECENT</span><span style={{ width: "20%" }}>NEW</span></div><p>The generator changes the musical surface—key, octave, direction, timbre, duration, and amplitude—without changing the underlying skill.</p><div className="generated-session">{session.slice(0, 5).map((item, index) => <button key={`${item.skillId}-${index}`} onClick={() => { setSelectedId(item.skillId); setView(skillView(item.definition)); }}><span>{String(index + 1).padStart(2, "0")}</span><span><b>{item.definition.label}</b><small>{pitchClassLabel(item.variation.keyPitchClass)}{item.variation.octave} · {item.variation.timbre} · {item.variation.direction}</small></span><i>{item.plannedBucket === "weak_due" ? "60" : item.plannedBucket === "recent" ? "20" : "20"}</i></button>)}</div><ActionButton className="wide" onClick={() => setSessionSeed((seed) => seed + 1)}><Icon name="spark" size={15} /> Reroll musical surfaces</ActionButton></Panel>
        </div>
      </div>
    </div>
  );
}
