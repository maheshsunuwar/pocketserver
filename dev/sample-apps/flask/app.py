import os
from flask import Flask
app = Flask(__name__)

@app.get("/")
def home():
    return "hello from flask on a phone"

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 5000)))
