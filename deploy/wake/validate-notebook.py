import os
import ast, json, re, subprocess, sys

NB = os.path.join(os.path.dirname(os.path.abspath(__file__)), "train-edmund-wake.ipynb")
nb = json.load(open(NB))
fails, warns = [], []

# --- 1. Valid notebook JSON / structure -------------------------------------
assert nb["nbformat"] == 4
print(f"[ok]   notebook JSON valid, {len(nb['cells'])} cells")

# --- 2. Every code cell must parse as Python (magics stripped) --------------
def strip_magics(src):
    out = []
    for line in src.split("\n"):
        s = line.strip()
        if s.startswith("!") or s.startswith("%"):
            out.append("pass")            # shell/magic line
        elif line.rstrip().endswith("\\") and (s.startswith("!") or s.startswith("%")):
            out.append("pass")
        else:
            out.append(line)
    # join continuation lines belonging to a stripped ! command
    txt = "\n".join(out)
    txt = re.sub(r"^pass\n(?:[^\n]*\\\n)*[^\n]*\n", "pass\n", txt, flags=re.M)
    return txt

ncode = 0
for i, c in enumerate(nb["cells"]):
    if c["cell_type"] != "code":
        continue
    ncode += 1
    src = "".join(c["source"])
    # remove shell blocks including backslash continuations
    lines, skip = [], False
    for line in src.split("\n"):
        if skip:
            if not line.rstrip().endswith("\\"):
                skip = False
            lines.append("pass")
            continue
        if line.lstrip().startswith(("!", "%")):
            skip = line.rstrip().endswith("\\")
            lines.append("pass")
        else:
            lines.append(line)
    try:
        ast.parse("\n".join(lines))
    except SyntaxError as e:
        fails.append(f"cell {i}: SyntaxError line {e.lineno}: {e.msg}")
print(f"[{'ok' if not fails else 'FAIL'}]   {ncode} code cells parse as Python")

# --- 3. Config keys must all be read by train.py ----------------------------
train_src = open("train.py").read()
read_keys = set(re.findall(r'config\["([a-z_]+)"\]', train_src))
cfg_cell = next(("".join(c["source"]) for c in nb["cells"]
                 if 'config["target_phrase"]' in "".join(c["source"])), "")
set_keys = set(re.findall(r'config\["([a-z_]+)"\]\s*=', cfg_cell))
unused = set_keys - read_keys
if unused:
    fails.append(f"config keys set but never read by train.py: {sorted(unused)}")
print(f"[{'ok' if not unused else 'FAIL'}]   all {len(set_keys)} config keys are read by train.py")

# --- 4. CLI flags must exist in train.py argparse ---------------------------
trainlines = [l for c in nb["cells"] if c["cell_type"]=="code"
              for l in "".join(c["source"]).split("\n") if "train.py" in l]
flags = set(re.findall(r"--([a-z_]+)(?![\w-])", " ".join(trainlines)))
declared = set(re.findall(r'"--([a-z_]+)"', train_src))
bad = flags - declared
if bad: fails.append(f"undeclared train.py flags: {sorted(bad)}")
print(f"[{'ok' if not bad else 'FAIL'}]   train.py flags used: {sorted(flags)}")

# --- 5. Every URL must return 200 -------------------------------------------
urls = sorted(set(re.findall(r"https?://[^\s'\"\\)]+", json.dumps(nb))))
urls = [u for u in urls if not u.startswith("https://huggingface.co/datasets/davidscripka/openwakeword_features/resolve") or True]
for u in urls:
    u = u.rstrip(".,")
    if "github.com/dscripka/openwakeword" in u and u.endswith("openwakeword"): continue
    code = subprocess.run(["curl","-sIL","-o","/dev/null","-w","%{http_code}",u],
                          capture_output=True, text=True).stdout.strip()
    tag = "ok" if code.startswith("2") else "FAIL"
    if tag == "FAIL": fails.append(f"URL {code}: {u}")
    print(f"[{tag}]   {code}  {u[:96]}")

# --- 6. Forbidden leftovers -------------------------------------------------
# executable lines only: comments in code cells document the deviations too
_exec = []
for c in nb["cells"]:
    if c["cell_type"] != "code": continue
    for l in "".join(c["source"]).split("\n"):
        code_part = l.split("#", 1)[0]
        if code_part.strip(): _exec.append(code_part)
whole = "\n".join(_exec)
for bad_s, why in [("pip install -q piper-phonemize", "no wheel for py3.12"),
                   ("tensorflow-cpu", "unavailable + unnecessary"),
                   ("onnx_tf", "unnecessary"),
                   ("bal_train09.tar", "404, repo is parquet now"),
                   ("rudraml/fma", "loading-script dataset"),
                   ("libritts_r-medium", "filename never looked up"),
                   ("pip install -q webrtcvad ", "sdist-only, needs -wheels")]:
    if bad_s in whole:
        fails.append(f"stale reference present: {bad_s!r} ({why})")
print(f"[{'ok' if not any('stale' in f for f in fails) else 'FAIL'}]   no stale references")

print("\n" + ("ALL CHECKS PASSED" if not fails else "FAILURES:\n  " + "\n  ".join(fails)))
if warns: print("warnings:\n  " + "\n  ".join(warns))
