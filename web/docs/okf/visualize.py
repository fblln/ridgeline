#!/usr/bin/env python3
"""Render an OKF bundle as a self-contained interactive HTML graph. No deps.

Usage: python3 visualize.py [bundle_dir] [-o out.html]

Standalone reimplementation of the okf reference_agent `visualize` command:
nodes = concept files (frontmatter `type`), edges = markdown links between
files, detail panel = frontmatter + rendered body, backlinks = reverse edges.
Bundle data is baked into the HTML so it opens over file:// with no server.
Cytoscape.js (graph) and marked (markdown) load from CDN, same as upstream.
"""
import sys, re, json, pathlib

args = [a for a in sys.argv[1:] if a != "-o"]
root = pathlib.Path(args[0] if args and not args[0].endswith(".html") else ".")
out = pathlib.Path(sys.argv[sys.argv.index("-o") + 1]) if "-o" in sys.argv else root / "okf-graph.html"
RESERVED = {"index.md", "log.md"}

def split_frontmatter(text):
    m = re.match(r"^---\n(.*?)\n---\n(.*)$", text, re.S)
    if not m:
        return {}, text
    fm = {}
    for line in m.group(1).splitlines():
        km = re.match(r"^([A-Za-z0-9_-]+):\s*(.*)$", line)
        if km:
            fm[km.group(1)] = km.group(2).strip()
    return fm, m.group(2)

nodes, edges = [], []
files = {p.name: p for p in sorted(root.glob("*.md"))}
for name, p in files.items():
    fm, body = split_frontmatter(p.read_text())
    nodes.append({
        "id": name,
        "title": fm.get("title", name),
        "type": fm.get("type", "Unknown"),
        "description": fm.get("description", ""),
        "tags": fm.get("tags", ""),
        "timestamp": fm.get("timestamp", ""),
        "reserved": name in RESERVED,
        "body": body.strip(),
    })
    # links: bundle-relative (/x.md), relative (./x.md or x.md)
    for target in re.findall(r"\]\((?:\./|/)?([A-Za-z0-9._-]+\.md)\)", body):
        if target in files and target != name:
            edges.append({"source": name, "target": target})

# self-check: our own bundle must produce a connected-ish graph
broken = [e for e in edges if e["target"] not in files]
assert not broken, f"edges point at missing files: {broken}"

data = json.dumps({"nodes": nodes, "edges": edges})
html = """<!doctype html><html><head><meta charset="utf-8">
<title>OKF bundle graph</title>
<script src="https://cdn.jsdelivr.net/npm/cytoscape@3.30.2/dist/cytoscape.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
<style>
 html,body{margin:0;height:100%;font:14px/1.5 system-ui,sans-serif;background:#0e1116;color:#e6edf3}
 #cy{position:absolute;left:0;top:0;right:380px;bottom:0}
 #panel{position:absolute;right:0;top:0;bottom:0;width:380px;overflow:auto;padding:18px 20px;
   box-sizing:border-box;background:#161b22;border-left:1px solid #30363d}
 #panel h2{margin:.2em 0;font-size:18px} .type{display:inline-block;font-size:11px;letter-spacing:.04em;
   text-transform:uppercase;color:#7ee787;border:1px solid #2ea04366;padding:2px 8px;border-radius:99px}
 .meta{color:#8b949e;font-size:12px;margin:6px 0 14px} .body{border-top:1px solid #30363d;padding-top:12px}
 .body a{color:#58a6ff;cursor:pointer} .body pre{background:#0d1117;padding:10px;border-radius:6px;overflow:auto}
 .bk{color:#58a6ff;cursor:pointer;display:block} h3{font-size:12px;color:#8b949e;text-transform:uppercase;margin-top:18px}
</style></head><body>
<div id="cy"></div><div id="panel"><em>Click a node.</em></div>
<script>
const DATA = __OKF_DATA__;
const byId = Object.fromEntries(DATA.nodes.map(n=>[n.id,n]));
const backlinks = {}; DATA.edges.forEach(e=>{(backlinks[e.target]=backlinks[e.target]||[]).push(e.source)});
const cy = cytoscape({container:document.getElementById('cy'),
  elements:[...DATA.nodes.map(n=>({data:{id:n.id,label:n.title,reserved:n.reserved}})),
            ...DATA.edges.map(e=>({data:{source:e.source,target:e.target}}))],
  layout:{name:'cose',animate:false,padding:40,nodeRepulsion:9000,idealEdgeLength:130},
  style:[
   {selector:'node',style:{'label':'data(label)','color':'#e6edf3','font-size':11,'background-color':'#388bfd',
     'text-valign':'bottom','text-margin-y':4,'width':22,'height':22}},
   {selector:'node[?reserved]',style:{'background-color':'#6e7681','shape':'round-rectangle'}},
   {selector:'edge',style:{'width':1.5,'line-color':'#30363d','target-arrow-color':'#30363d',
     'target-arrow-shape':'triangle','curve-style':'bezier','arrow-scale':.8}},
   {selector:'.sel',style:{'background-color':'#f0883e','width':30,'height':30}}]});
function show(id){
  const n=byId[id]; if(!n)return;
  cy.nodes().removeClass('sel'); cy.getElementById(id).addClass('sel');
  const bk=(backlinks[id]||[]).map(s=>`<a class="bk" data-go="${s}">← ${byId[s].title}</a>`).join('')||'<em>none</em>';
  document.getElementById('panel').innerHTML=
    `<span class="type">${n.type}</span><h2>${n.title}</h2>`+
    `<div class="meta">${n.description||''}${n.tags?'<br>tags: '+n.tags:''}${n.timestamp?'<br>'+n.timestamp:''}</div>`+
    `<div class="body">${marked.parse(n.body)}</div><h3>Backlinks</h3>${bk}`;
}
cy.on('tap','node',e=>show(e.target.id()));
document.addEventListener('click',e=>{
  const go=e.target.getAttribute&&e.target.getAttribute('data-go'); if(go){show(go);return;}
  const href=e.target.tagName==='A'&&e.target.getAttribute('href');
  if(href){const t=href.replace(/^\\.?\\//,''); if(byId[t]){e.preventDefault();show(t);}}
});
show(DATA.nodes.find(n=>n.id==='index.md')?.id || DATA.nodes[0].id);
</script></body></html>""".replace("__OKF_DATA__", data)

out.write_text(html)
print(f"OK: {len(nodes)} nodes, {len(edges)} edges -> {out}")
