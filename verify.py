import os, re
f = 'TODO.md'
t = open(f, encoding='utf-8').read()

def check(name, cond):
    print(name + ': ' + ('OK' if cond else 'FAIL'))
    return cond

all_ok = True

# 1. filename
all_ok &= check('filename', os.path.exists(f))

# 2. checkboxes count
cbs = re.findall(r'^- \[ \]', t, re.M)
all_ok &= check('checkboxes=5', len(cbs) == 5)

# 3. blank rule
lines = t.splitlines()
ok = True
for i, ln in enumerate(lines):
    if re.match(r'^- \[ \]', ln):
        if i + 1 >= len(lines) or lines[i + 1] != '':
            ok = False
            break
all_ok &= check('blank rule', ok)

# 4. no emoji
emoji_chars = []
for ch in t:
    cp = ord(ch)
    in_blocks = (
        0x1F300 <= cp <= 0x1FAFF or
        0x2600 <= cp <= 0x27BF or
        0x1F600 <= cp <= 0x1F64F or
        0x1F900 <= cp <= 0x1F9FF or
        0x2700 <= cp <= 0x27BF
    )
    if in_blocks:
        emoji_chars.append(ch)
all_ok &= check('no emoji', len(emoji_chars) == 0)

# 5. no tab
all_ok &= check('no tab', '\t' not in t)

print('ALL_PASS' if all_ok else 'ALL_FAIL')
</content>
</invoke>