import re
data = open('TODO.md', 'rb').read().decode('utf-8')
lines = data.splitlines()
boxes = re.findall(r'^- \[ \]', data, flags=re.M)
oks = 0
for i, l in enumerate(lines):
    if re.match(r'^- \[ \]', l) and i + 1 < len(lines) and lines[i + 1] == '':
        oks += 1
emoji = sum(1 for ch in data if (0x1F300 <= ord(ch) <= 0x1FAFF) or (0x2600 <= ord(ch) <= 0x27BF))
trailing = data.endswith('\n\n')
print('NAME TODO.md')
print('BOX', len(boxes))
print('BLANK_AFTER_PAIRS', oks)
print('TRAILING_DOUBLE_NL', trailing)
print('TAB', data.count('\t'))
print('EMOJI', emoji)
ok = (len(boxes) == 5) and (oks == 5) and trailing and (data.count('\t') == 0) and (emoji == 0)
print('ALL_PASS', ok)