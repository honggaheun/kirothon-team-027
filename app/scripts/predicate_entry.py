import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from chaenggim.rules import check

data = json.loads(sys.stdin.buffer.read().decode('utf-8'))
sys.stdout.buffer.write(json.dumps(check(data), ensure_ascii=False).encode('utf-8'))
