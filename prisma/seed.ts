import { PrismaClient } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import { Pool } from 'pg'

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
})

const adapter = new PrismaPg(pool)
const prisma = new PrismaClient({ adapter })

async function main() {
  const products = [
    {
      brand: 'Apres',
      productLine: 'Natural',
      shape: 'Almond',
      length: 'Medium',
      displayName: 'Apres Natural Almond Medium',
    },
    {
      brand: 'Apres',
      productLine: 'Natural',
      shape: 'Coffin',
      length: 'Medium',
      displayName: 'Apres Natural Coffin Medium',
    },
    {
      brand: 'Apres',
      productLine: 'Natural',
      shape: 'Stiletto',
      length: 'Medium',
      displayName: 'Apres Natural Stiletto Medium',
    },
    {
      brand: 'Apres',
      productLine: 'Sculpted',
      shape: 'Almond',
      length: 'Medium',
      displayName: 'Apres Sculpted Almond Medium',
    },
    {
      brand: 'Apres',
      productLine: 'Sculpted',
      shape: 'Coffin',
      length: 'Medium',
      displayName: 'Apres Sculpted Coffin Medium',
    },
    {
      brand: 'Apres',
      productLine: 'Sculpted',
      shape: 'Stiletto',
      length: 'Medium',
      displayName: 'Apres Sculpted Stiletto Medium',
    },
    {
      brand: 'Sofgel',
      productLine: 'XVN',
      shape: 'Almond',
      length: 'Medium',
      displayName: 'Sofgel XVN Almond Medium',
    },
    {
      brand: 'Sofgel',
      productLine: 'XVN',
      shape: 'Coffin',
      length: 'Medium',
      displayName: 'Sofgel XVN Coffin Medium',
    },
    {
      brand: 'Sofgel',
      productLine: 'XVN',
      shape: 'Stiletto',
      length: 'Medium',
      displayName: 'Sofgel XVN Stiletto Medium',
    },
    {
      brand: 'Sofgel',
      productLine: 'XVS',
      shape: 'Almond',
      length: 'Medium',
      displayName: 'Sofgel XVS Almond Medium',
    },
    {
      brand: 'Sofgel',
      productLine: 'XVS',
      shape: 'Coffin',
      length: 'Medium',
      displayName: 'Sofgel XVS Coffin Medium',
    },
    {
      brand: 'Sofgel',
      productLine: 'XVS',
      shape: 'Stiletto',
      length: 'Medium',
      displayName: 'Sofgel XVS Stiletto Medium',
    },
  ]

  for (const product of products) {
    await prisma.product.upsert({
      where: {
        brand_productLine_shape_length: {
          brand: product.brand,
          productLine: product.productLine,
          shape: product.shape,
          length: product.length,
        },
      },
      update: {},
      create: product,
    })
  }

  console.log(`Seeded ${products.length} products`)
}

main()
  .catch(console.error)
  .finally(async () => {
  await prisma.$disconnect()
  await pool.end()
})