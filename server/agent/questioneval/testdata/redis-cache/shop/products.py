from .db import connect


def get_product(product_id: int) -> dict | None:
    # Joins prices, stock and reviews; takes ~800ms on production data.
    with connect() as conn:
        row = conn.execute(
            """
            SELECT p.id, p.name, pr.amount, s.quantity, avg(r.stars)
            FROM products p
            JOIN prices pr ON pr.product_id = p.id
            JOIN stock s ON s.product_id = p.id
            LEFT JOIN reviews r ON r.product_id = p.id
            WHERE p.id = %s
            GROUP BY p.id, pr.amount, s.quantity
            """,
            (product_id,),
        ).fetchone()
    if row is None:
        return None
    return {"id": row[0], "name": row[1], "price": row[2], "stock": row[3], "rating": row[4]}
