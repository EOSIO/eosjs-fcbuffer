const ByteBuffer = require('bytebuffer')
const Struct = require('./struct')

module.exports = {
  create,
  toBuffer,
  fromBuffer
}

/**
  @summary Create a serializer for each definition.
  @return {CreateStruct}
*/
function create(definitions, types, config = types.config) {
  const errors = []
  if(!config.sort) {
    config.sort = {}
  }

  // Basic structure validation
  for (const key in definitions) {
    const value = definitions[key]
    const {base, fields} = value
    const typeOfValue = typeof value
    if (typeOfValue === 'object') {
      if (!base && !fields) {
        errors.push(`Expecting ${key}.fields or ${key}.base`)
        continue
      }
      if (base && typeof base !== 'string') {
        errors.push(`Expecting string ${key}.base`)
      }
      if (fields) {
        if (typeof fields !== 'object') {
          errors.push(`Expecting object ${key}.fields`)
        } else {
          for (const field in fields) {
            if (typeof fields[field] !== 'string') {
              errors.push(`Expecting string in ${key}.fields.${field}`)
            }
          }
        }
      }
    } else if (typeOfValue !== 'string') {
      errors.push(`Expecting object or string under ${key}, instead got ${typeof value}`)
      continue
    }
  }
  
  // Keys with objects are structs
  const structs = {}
  for (const key in definitions) {
    const value = definitions[key]
    if (typeof value === 'object') {
      structs[key] = Struct(key, config)
    }
  }

  // Resolve user-friendly typedef names pointing to a native type (or another typedef)
  for (const key in definitions) {
    const value = definitions[key]
    if (typeof value === 'string') {
      const type = types[value]
      if (type) {
        types[key] = type
      } else {
        // example: key === 'fields' && value === field[]
        const struct = getTypeOrStruct(key, value) // type = vector(field)
        if(struct) {
          structs[key] = struct
        } else {
          errors.push(`Unrecognized type or struct ${key}.${value}`)
        }
      }
    }
  }

  // Structs can inherit another struct, they will share the same instance
  for (const key in definitions) {
    const thisStruct = structs[key]
    if (!thisStruct) continue
    const value = definitions[key]
    if (typeof value === 'object' && value.base) {
      const base = value.base
      const baseStruct = structs[base]
      if (!baseStruct) {
        errors.push(`Missing ${base} in ${key}.base`)
        continue
      }
      thisStruct.add('', structPtr(baseStruct))
    }
  }

  // Create types from a string (ex vector[Type])
  function getTypeOrStruct (key, Type, typeArgs, fieldName) {
    const typeatty = parseType(Type)
    if (!typeatty) return null
    const {name, annotation, arrayType} = typeatty
    let ret
    if(annotation) {
      // any_type<field_name, type_name>
      const type = types[name]
      if(type == null) {
        errors.push(`Missing ${name} in ${Type}`)
        return null
      }
      const annTypes = []
      for(let annTypeName of annotation) {
        const annType = getTypeOrStruct(key, annTypeName, null, fieldName)
        if(!annType) {
          errors.push(`Missing ${annTypeName} in ${Type}`)
          return null
        }
        annTypes.push(annType)
      }
      ret = type(annTypes)
    } else if (arrayType == null) {
      // AnyType
      const fieldStruct = structs[name]
      if (fieldStruct) { return typeatty.optional ? types.optional(fieldStruct) : fieldStruct }

      const type = types[name]
      if (!type) {
        return null
      }

      // types need to be instantiated
      ret = type(typeArgs)
    } else if (arrayType === '') {
      // AnyType[]
      const nameType = getTypeOrStruct(key, typeatty.name, null, fieldName)
      if (!nameType) { return null }

      const sort = config.sort[`${key}.${fieldName}`] || false
      // console.log('sort?', `${key}.${fieldName}`, sort, config.sort)
      ret = types.vector(nameType, sort)
    } else if (arrayType.length > 0) {
      // vector[Type]
      const arrayTs = getTypeOrStruct(key, typeatty.arrayType, null, fieldName)
      if (!arrayTs) {
        errors.push(`Missing ${typeatty.arrayType} in ${Type}`)
        return null
      }
      const baseTs = getTypeOrStruct(key, typeatty.name, arrayTs, fieldName)
      if (!baseTs) {
        errors.push(`Missing ${typeatty.name} in ${Type}`)
        return null
      }
      ret = baseTs
    }
    return typeatty.optional ? types.optional(ret) : ret
  }

  // Add all the fields.  Thanks to structPtr no need to look at base types.
  for (const key in definitions) {
    const thisStruct = structs[key]
    if (!thisStruct) continue
    const value = definitions[key]
    if (!value.fields) continue
    const {fields} = value
    for (const Field in fields) {
      const Type = fields[Field]
      const ts = getTypeOrStruct(key, Type, null, Field)
      if (!ts) {
        errors.push(`Missing ${Type} in ${key}.fields.${Field}`)
        continue
      }
      thisStruct.add(Field, ts)
    }
  }

  if (errors.length) {
    // 'structs' could contain invalid references
    return {errors}
  }

  return {errors, structs}
}

const parseType = name => {
  if (!name || typeof name !== 'string') { return null }

  name = name.trim()

  const annotationMatch = name.match(/<(.*)>/)
  if(annotationMatch) {
    const annotation = annotationMatch ?
      annotationMatch[1].replace(/ /g, '').split(',') : null

    name = name.replace(annotationMatch[0], '').trim()
    return {name, annotation}
  }

  const arrayMatch = name.match(/\[(.*)\]/)
  const arrayType = arrayMatch ? arrayMatch[1].trim() : null

  if (arrayMatch) { name = name.replace(arrayMatch[0], '').trim() }

  let optional = false
  if (/\?$/.test(name)) {
    name = name.substring(0, name.length - 1)
    optional = true
  }
  return {name, arrayType, optional}
}

/**
  Base types all point to the same struct.

  Note, appendByteBuffer has no return type.
*/
const structPtr = type => ({
  fromByteBuffer: (b) => type.fromByteBuffer(b),
  appendByteBuffer: (b, value) => { type.appendByteBuffer(b, value) },
  fromObject: (value) => type.fromObject(value),
  toObject: (value) => type.toObject(value)
})


function toBuffer (type, value) {
  const struct = type.fromObject(value)
  return Buffer.from(toByteBuffer(type, struct).toBinary(), 'binary')
}

function fromBuffer (type, buffer, toObject = true) {
  const b = ByteBuffer.fromBinary(buffer.toString('binary'), ByteBuffer.LITTLE_ENDIAN)
  const struct = type.fromByteBuffer(b)
  return toObject ? type.toObject(struct) : struct
}

function toByteBuffer (type, value) {
  const b = new ByteBuffer(ByteBuffer.DEFAULT_CAPACITY, ByteBuffer.LITTLE_ENDIAN)
  type.appendByteBuffer(b, value)
  return b.copy(0, b.offset)
}
