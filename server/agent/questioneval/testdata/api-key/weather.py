import json
import os
import sys
import urllib.parse
import urllib.request
from pathlib import Path


def load_env() -> None:
    env = Path(__file__).with_name(".env")
    if not env.exists():
        return
    for line in env.read_text().splitlines():
        key, sep, value = line.partition("=")
        if sep and value:
            os.environ.setdefault(key.strip(), value.strip())


def main(city: str) -> None:
    load_env()
    key = os.environ.get("OPENWEATHER_API_KEY")
    if not key:
        sys.exit("OPENWEATHER_API_KEY is not set (see .env.example)")
    query = urllib.parse.urlencode({"q": city, "appid": key, "units": "metric"})
    with urllib.request.urlopen(f"https://api.openweathermap.org/data/2.5/weather?{query}") as resp:
        data = json.load(resp)
    print(f"{data['name']}: {data['weather'][0]['description']}, {data['main']['temp']}°C")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "Tokyo")
