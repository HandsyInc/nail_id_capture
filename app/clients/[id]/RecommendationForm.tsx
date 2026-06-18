"use client";

import { useMemo, useState } from "react";

type Product = {
  id: string;
  brand: string;
  productLine: string;
  shape: string;
  length: string;
  displayName: string;
};

export function RecommendationForm({
  products,
  action,
}: {
  products: Product[];
  action: (formData: FormData) => void;
}) {
  const [brand, setBrand] = useState(products[0]?.brand || "");
  const [productLine, setProductLine] = useState(products[0]?.productLine || "");
  const [shape, setShape] = useState(products[0]?.shape || "");
  const [length, setLength] = useState(products[0]?.length || "");

  const brands = [...new Set(products.map((p) => p.brand))];

  const productLines = [
    ...new Set(
      products
        .filter((p) => p.brand === brand)
        .map((p) => p.productLine)
    ),
  ];

  const shapes = [
    ...new Set(
      products
        .filter((p) => p.brand === brand && p.productLine === productLine)
        .map((p) => p.shape)
    ),
  ];

  const lengths = [
    ...new Set(
      products
        .filter(
          (p) =>
            p.brand === brand &&
            p.productLine === productLine &&
            p.shape === shape
        )
        .map((p) => p.length)
    ),
  ];

  const selectedProduct = useMemo(() => {
    return products.find(
      (p) =>
        p.brand === brand &&
        p.productLine === productLine &&
        p.shape === shape &&
        p.length === length
    );
  }, [products, brand, productLine, shape, length]);

  return (
    <form action={action}>
      <input type="hidden" name="productId" value={selectedProduct?.id || ""} />

      <p>
        <label>
          Brand{" "}
          <select
            value={brand}
            onChange={(event) => {
  const nextBrand = event.target.value;
  const nextProductLine =
    products.find((p) => p.brand === nextBrand)?.productLine || "";
  const nextShape =
    products.find(
      (p) => p.brand === nextBrand && p.productLine === nextProductLine
    )?.shape || "";
  const nextLength =
    products.find(
      (p) =>
        p.brand === nextBrand &&
        p.productLine === nextProductLine &&
        p.shape === nextShape
    )?.length || "";

  setBrand(nextBrand);
  setProductLine(nextProductLine);
  setShape(nextShape);
  setLength(nextLength);
}}
            required
            style={{ color: "black" }}
          >
            {brands.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
      </p>

      <p>
        <label>
          Product Line{" "}
          <select
            value={productLine}
            onChange={(event) => {
  const nextProductLine = event.target.value;

  const nextShape =
    products.find(
      (p) => p.brand === brand && p.productLine === nextProductLine
    )?.shape || "";

  const nextLength =
    products.find(
      (p) =>
        p.brand === brand &&
        p.productLine === nextProductLine &&
        p.shape === nextShape
    )?.length || "";

  setProductLine(nextProductLine);
  setShape(nextShape);
  setLength(nextLength);
}}
            required
            style={{ color: "black" }}
          >
            {productLines.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
      </p>

      <p>
        <label>
          Shape{" "}
          <select
            value={shape}
            onChange={(event) => {
  const nextShape = event.target.value;

  const nextLength =
    products.find(
      (p) =>
        p.brand === brand &&
        p.productLine === productLine &&
        p.shape === nextShape
    )?.length || "";

  setShape(nextShape);
  setLength(nextLength);
}}
            required
            style={{ color: "black" }}
          >
            {shapes.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
      </p>

      <p>
        <label>
          Length{" "}
          <select
            value={length}
            onChange={(event) => setLength(event.target.value)}
            required
            style={{ color: "black" }}
          >
            {lengths.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
      </p>

      <h3>Left Hand</h3>
      {["Thumb", "Index", "Middle", "Ring", "Pinky"].map((finger) => (
        <p key={`left-${finger}`}>
          <label>
            {finger} <input name={`left${finger}`} style={{ color: "black" }} />
          </label>
        </p>
      ))}

      <h3>Right Hand</h3>
      {["Thumb", "Index", "Middle", "Ring", "Pinky"].map((finger) => (
        <p key={`right-${finger}`}>
          <label>
            {finger}{" "}
            <input name={`right${finger}`} style={{ color: "black" }} />
          </label>
        </p>
      ))}

      <button type="submit" disabled={!selectedProduct}>
        Save Recommendation
      </button>
    </form>
  );
}