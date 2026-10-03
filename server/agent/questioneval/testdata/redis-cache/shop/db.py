import os

import psycopg


def connect():
    return psycopg.connect(os.environ["DATABASE_URL"])
