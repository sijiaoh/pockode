from flask import Blueprint, abort, jsonify, request

from . import rate_limit
from .products import get_product

bp = Blueprint("shop", __name__)


@bp.before_request
def limit():
    if not rate_limit.allow(request.remote_addr or "unknown"):
        abort(429)


@bp.get("/products/<int:product_id>")
def product(product_id: int):
    found = get_product(product_id)
    if found is None:
        abort(404)
    return jsonify(found)
