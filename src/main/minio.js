/*
 * Minimal Object Storage Library, (C) 2015 Minio, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

require('source-map-support').install()

var BlockStream2 = require('block-stream2')
var Concat = require('concat-stream')
var Crypto = require('crypto')
var Http = require('http')
var Moment = require('moment')
var ParseXml = require('xml-parser')
var Stream = require('stream')
var Through2 = require('through2')
var Xml = require('xml')

class Client {
  constructor(params, transport) {
    "use strict"
    if (transport) {
      this.transport = transport
    } else {
      this.transport = Http
    }
    this.params = params
  }

  // SERIVCE LEVEL CALLS

  makeBucket(bucket, cb) {
    "use strict"

    if (bucket == null || bucket.trim() === "") {
      return cb('bucket name cannot be empty')
    }

    var payloadObject = {
      CreateBucketConfiguration: [{
        _attr: {
          xmlns: 'http://s3.amazonaws.com/doc/2006-03-01/'
        }
      }, {
        LocationConstraint: getRegion(this.params.host)
      }]
    }

    var payload = Xml(payloadObject)

    var stream = new Stream.Readable()
    stream.push(payload.toString())
    stream.push(null)

    var hash = Crypto.createHash('sha256')
    hash.update(payload)
    var sha256 = hash.digest('hex').toLowerCase()

    var requestParams = {
      host: this.params.host,
      port: this.params.port,
      method: 'PUT',
      path: `/${bucket}`,
      headers: {
        'Content-Length': payload.length
      }
    }
    signV4(requestParams, sha256, this.params.accessKey, this.params.secretKey)

    var req = this.transport.request(requestParams, response => {
      if (response.statusCode !== 200) {
        return parseError(response, cb)
      }
      cb()
    })
    stream.pipe(req)
  }

  listBuckets() {
    var requestParams = {
      host: this.params.host,
      port: this.params.port,
      path: '/',
      method: 'GET'
    }

    signV4(requestParams, '', this.params.accessKey, this.params.secretKey)

    var stream = new Stream.Readable({
      objectMode: true
    })
    stream._read = () => {
    }

    var req = this.transport.request(requestParams, (response) => {
      if (response.statusCode !== 200) {
        // TODO work out how to handle errors with stream
        stream.push(parseError(response, (error) => {
          "use strict";
          stream.emit('error', error)
        }))
        stream.push(null)
      }
      response.pipe(Concat(errorXml => {
        "use strict";
        var parsedXml = ParseXml(errorXml.toString())
        parsedXml.root.children.forEach(element => {
          "use strict";
          if (element.name === 'Buckets') {
            element.children.forEach(bucketListing => {
              var bucket = {}
              bucketListing.children.forEach(prop => {
                switch (prop.name) {
                  case "Name":
                    bucket.name = prop.content
                    break
                  case "CreationDate":
                    bucket.creationDate = prop.content
                    break
                }
              })
              stream.push(bucket)
            })
          }
        })
        stream.push(null)
      }))
    })
    req.end()
    return stream
  }

  bucketExists(bucket, cb) {
    "use strict";

    if (bucket == null || bucket.trim() === "") {
      return cb('bucket name cannot be empty')
    }

    var requestParams = {
      host: this.params.host,
      port: this.params.port,
      method: 'HEAD',
      path: `/${bucket}`
    }

    signV4(requestParams, '', this.params.accessKey, this.params.secretKey)

    var req = this.transport.request(requestParams, response => {
      if (response.statusCode !== 200) {
        return parseError(response, cb)
      }
      cb()
    })
    req.end()
  }

  removeBucket(bucket, cb) {
    "use strict";

    if (bucket == null || bucket.trim() === "") {
      return cb('bucket name cannot be empty')
    }

    var requestParams = {
      host: this.params.host,
      port: this.params.port,
      method: 'DELETE',
      path: `/${bucket}`
    }

    signV4(requestParams, '', this.params.accessKey, this.params.secretKey)

    var req = this.transport.request(requestParams, response => {
      if (response.statusCode !== 204) {
        return parseError(response, cb)
      }
      cb()
    })
    req.end()
  }

  getBucketACL(bucket, cb) {
    "use strict";

    if (bucket == null || bucket.trim() === "") {
      return cb('bucket name cannot be empty')
    }

    var query = `?acl`;
    var requestParams = {
      host: this.params.host,
      port: this.params.port,
      method: 'GET',
      path: `/${bucket}${query}`,
    }

    signV4(requestParams, '', this.params.accessKey, this.params.secretKey)

    var req = this.transport.request(requestParams, response => {
      if (response.statusCode !== 200) {
        return parseError(response, cb)
      }
      response.pipe(Concat((body) => {
        var xml = ParseXml(body.toString())

        var publicRead = false
        var publicWrite = false
        var authenticatedRead = false
        var authenticatedWrite = false

        xml.root.children.forEach(element => {
          switch (element.name) {
            case "AccessControlList":
              element.children.forEach(grant => {
                var granteeURL = null
                var permission = null
                grant.children.forEach(grantChild => {
                  switch (grantChild.name) {
                    case "Grantee":
                      grantChild.children.forEach(grantee => {
                        switch (grantee.name) {
                          case "URI":
                            granteeURL = grantee.content
                            break
                        }
                      })
                      break
                    case "Permission":
                      permission = grantChild.content
                      break
                  }
                })
                if (granteeURL === 'http://acs.amazonaws.com/groups/global/AllUsers') {
                  if (permission === 'READ') {
                    publicRead = true
                  } else if (permission === 'WRITE') {
                    publicWrite = true
                  }
                } else if (granteeURL === 'http://acs.amazonaws.com/groups/global/AuthenticatedUsers') {
                  if (permission === 'READ') {
                    authenticatedRead = true
                  } else if (permission === 'WRITE') {
                    authenticatedWrite = true
                  }
                }
              })
              break
          }
        })
        var cannedACL = 'unsupported-acl'
        if (publicRead && publicWrite && !authenticatedRead && !authenticatedWrite) {
          cannedACL = 'public-read-write'
        } else if (publicRead && !publicWrite && !authenticatedRead && !authenticatedWrite) {
          cannedACL = 'public-read'
        } else if (!publicRead && !publicWrite && authenticatedRead && !authenticatedWrite) {
          cannedACL = 'authenticated-read'
        } else if (!publicRead && !publicWrite && !authenticatedRead && !authenticatedWrite) {
          cannedACL = 'private'
        }
        cb(null, cannedACL)
      }))
    })
    req.end()
  }

  setBucketACL(bucket, acl, cb) {
    "use strict"

    if (bucket == null || bucket.trim() === "") {
      return cb('bucket name cannot be empty')
    }

    if (acl == null || acl.trim() === "") {
      return cb('acl name cannot be empty')
    }

    // we should make sure to set this query parameter, but the call apparently succeeds without it to s3
    // To differentiate this functionality from makeBucket() lets do it anyways.
    if (bucket == null || bucket.trim() === "") {
      return cb('bucket name cannot be empty')
    }
    var query = `?acl`;
    var requestParams = {
      host: this.params.host,
      port: this.params.port,
      method: 'PUT',
      path: `/${bucket}${query}`,
      headers: {
        'x-amz-acl': acl
      }
    }

    signV4(requestParams, '', this.params.accessKey, this.params.secretKey)

    var req = this.transport.request(requestParams, response => {
      if (response.statusCode !== 200) {
        return parseError(response, cb)
      }
      cb()
    })
    req.end()
  }

  dropAllIncompleteUploads(bucket, cb) {
    "use strict";

    if (bucket == null || bucket.trim() === "") {
      return cb('bucket name cannot be empty')
    }

    dropUploads(this.transport, this.params, bucket, null, cb)
  }

  dropIncompleteUpload(bucket, key, cb) {
    "use strict";

    if (bucket == null || bucket.trim() === "") {
      return cb('bucket name cannot be empty')
    }

    if (key == null || key.trim() === "") {
      return cb('object key cannot be empty')
    }

    dropUploads(this.transport, this.params, bucket, key, cb)
  }

  getObject(bucket, object, cb) {
    "use strict";

    if (bucket == null || bucket.trim() === "") {
      return cb('bucket name cannot be empty')
    }

    if (object == null || object.trim() === "") {
      return cb('object key cannot be empty')
    }

    var requestParams = {
      host: this.params.host,
      port: this.params.port,
      path: `/${bucket}/${object}`,
      method: 'GET'
    }

    signV4(requestParams, '', this.params.accessKey, this.params.secretKey)

    var req = this.transport.request(requestParams, (response) => {
      if (response.statusCode !== 200) {
        return parseError(response, cb)
      }
      // wrap it in a new pipe to strip additional response data
      cb(null, response.pipe(Through2((data, enc, done) => {
        done(null, data)
      })))

    })
    req.end()
  }

  putObject(bucket, key, contentType, size, r, cb) {
    "use strict";

    if (bucket == null || bucket.trim() === "") {
      return cb('bucket name cannot be empty')
    }

    if (key == null || key.trim() === "") {
      return cb('object key cannot be empty')
    }

    var self = this

    var uploadId = null
    var part = null

    var etags = []

    if (size > 5 * 1024 * 1024) {
      var stream = listAllIncompleteUploads(this.transport, this.params, bucket, key)
      var uploadId = null
      stream.on('error', (e) => {
        cb(e)
      })
      stream.pipe(Through2.obj(function(upload, enc, done) {
        uploadId = upload.uploadId
        done()
      }, function(done) {
        if (!uploadId) {
          initiateNewMultipartUpload(self.transport, self.params, bucket, key, (e, uploadId) => {
            if (e) {
              return done(e)
            }
            streamUpload(self.transport, self.params, bucket, key, uploadId, [], size, r, (e) => {
              return completeMultipartUpload(self.transport, self.params, bucket, key, uploadId, etags, (e) => {
                done()
                cb(e)
              })
            })
          })
        } else {
          var parts = listAllParts(self.transport, self.params, bucket, key, uploadId)
          parts.on('error', (e) => {
            cb(e)
          })
          var partsErrorred = null
          var partsArray = []
          parts.pipe(Through2.obj(function(part, enc, partDone) {
            partsArray.push(part)
            partDone()
          }, function(partDone) {
            if (partsErrorred) {
              return partDone(partsErrorred)
            }
            streamUpload(self.transport, self.params, bucket, key, uploadId, partsArray, size, r, (e) => {
              if (partsErrorred) {
                partDone()
              }
              if (e) {
                partDone()
                return cb(e)
              }
              completeMultipartUpload(self.transport, self.params, bucket, key, uploadId, etags, (e) => {
                partDone()
                return cb(e)
              })
            })
          }))
        }
      }))

      function streamUpload(transport, params, bucket, key, uploadId, partsArray, totalSize, r, cb) {
        var part = 1
        var errorred = null
        // compute size
        var blockSize = calculateBlockSize(size)
        var seen = 0
        r.on('finish', () => {
        })
        r.pipe(BlockStream2({
          size: blockSize,
          zeroPadding: false
        })).pipe(Through2.obj(function(data, enc, done) {
          if (errorred) {
            return done()
          }
          var currentSize = blockSize
          var curPart = part
          part = part + 1
          if (partsArray.length > 0) {
            var curPart = partsArray.shift()
            var hash = Crypto.createHash('md5')
            hash.update(data)
            var md5 = hash.digest('hex').toLowerCase()
            if (curPart.etag == md5) {
              etags.push({
                part: curPart,
                etag: md5
              })
              done()
            } else {
              errorred = 'mismatched etag'
              return done()
            }
          } else {
            var dataStream = new Stream.Readable()
            dataStream.push(data)
            dataStream.push(null)
            dataStream._read = () => {
            }
            doPutObject(transport, params, bucket, key, contentType, data.length, uploadId, curPart, dataStream, (e, etag) => {
              if (errorred) {
                return done()
              }
              if (e) {
                errorred = e
                return done()
              }
              etags.push({
                part: curPart,
                etag: etag
              })
              return done()
            })
          }
        }, function(done) {
          done()
          cb(errorred)
        }))

        function calculateBlockSize(size) {
          var minimumPartSize = 5 * 1024 * 1024; // 5MB
          var partSize = Math.floor(size / 9999); // using 10000 may cause part size to become too small, and not fit the entire object in
          return Math.max(minimumPartSize, partSize);
        }
      }
    } else {
      doPutObject(this.transport, this.params, bucket, key, contentType, size, null, null, r, cb)
    }
  }

  listObjects(bucket, params) {
    "use strict";
    var self = this

    var prefix = null
    var delimiter = null
    if (params) {
      if (params.prefix) {
        prefix = params.prefix
      }
      // we delimit when recursive is false
      if (params.recursive == false) {
        delimiter = '/'
      }
    }

    var queue = new Stream.Readable({
      objectMode: true
    })
    queue._read = () => {
    }
    var stream = queue.pipe(Through2.obj(function(currentRequest, enc, done) {
      getObjectList(self.transport, self.params, currentRequest.bucket, currentRequest.prefix, currentRequest.marker, currentRequest.delimiter, currentRequest.maxKeys, (e, r) => {
        if (e) {
          return done(e)
        }
        r.objects.forEach(object => {
          this.push(object)
        })
        if (r.isTruncated) {
          queue.push({
            bucket: currentRequest.bucket,
            prefix: currentRequest.prefix,
            marker: r.marker,
            delimiter: currentRequest.delimiter,
            maxKeys: currentRequest.maxKeys
          })
          queue.push(null)
        } else {
          queue.push(null)
        }
        done()
      })
    }))
    queue.push({
      bucket: bucket,
      prefix: prefix,
      marker: null,
      delimiter: delimiter,
      maxKeys: 1000
    })
    return stream

  }

  statObject(bucket, object, cb) {
    "use strict";

    if (bucket == null || bucket.trim() === "") {
      return cb('bucket name cannot be empty')
    }

    if (object == null || object.trim() === "") {
      return cb('object key cannot be empty')
    }

    var requestParams = {
      host: this.params.host,
      port: this.params.port,
      path: `/${bucket}/${object}`,
      method: 'HEAD'
    }

    signV4(requestParams, '', this.params.accessKey, this.params.secretKey)

    var req = this.transport.request(requestParams, (response) => {
      if (response.statusCode !== 200) {
        return parseError(response, cb)
      } else {
        var result = {
          size: +response.headers['content-length'],
          etag: response.headers['etag'],
          lastModified: response.headers['last-modified']
        }
        cb(null, result)
      }
    })
    req.end()
  }

  removeObject(bucket, object, cb) {
    "use strict";

    if (bucket == null || bucket.trim() === "") {
      return cb('bucket name cannot be empty')
    }

    if (object == null || object.trim() === "") {
      return cb('object key cannot be empty')
    }

    var requestParams = {
      host: this.params.host,
      port: this.params.port,
      path: `/${bucket}/${object}`,
      method: 'DELETE'
    }

    signV4(requestParams, '', this.params.accessKey, this.params.secretKey)

    var req = this.transport.request(requestParams, (response) => {
      if (response.statusCode !== 204) {
        return parseError(response, cb)
      }
      cb()
    })
    req.end()
  }
}

var parseError = (response, cb) => {
  "use strict";
  if (response.statusCode === 301) {
    return cb({
      code: 'MovedPermanently',
      message: 'Moved Permanently',
      requestId: null,
      hostId: null,
      resource: null
    })
  }
  if(response.statusCode === 404) {
    return cb({
      code: 'NotFound',
      message: '404: Not Found',
      requestId: null,
      hostId: null,
      resource: null
    })
  }
  response.pipe(Concat(errorXml => {
    var parsedXml = ParseXml(errorXml.toString())
    var e = {}
    parsedXml.root.children.forEach(element => {
      if (element.name === 'Code') {
        e.code = element.content
      } else if (element.name === 'Message') {
        e.message = element.content
      } else if (element.name === 'RequestId') {
        e.requestid = element.content
      } else if (element.name === 'Resource') {
        e.resource = element.content
      } else if (element.name === 'HostId') {
        e.hostid = element.content
      }
    })
    cb(e)
  }))
}

var getStringToSign = function(canonicalRequestHash, requestDate, region) {
  "use strict";
  var stringToSign = "AWS4-HMAC-SHA256\n"
  stringToSign += requestDate.format('YYYYMMDDTHHmmSS') + 'Z\n'
  stringToSign += `${requestDate.format('YYYYMMDD')}/${region}/s3/aws4_request\n`
  stringToSign += canonicalRequestHash
  return stringToSign
}

var signV4 = (request, dataShaSum256, accessKey, secretKey) => {
  "use strict";

  if (!accessKey || !secretKey) {
    return
  }

  var requestDate = Moment().utc()

  if (!dataShaSum256) {
    dataShaSum256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
  }

  if (!request.headers) {
    request.headers = {}
  }

  var region = getRegion(request.host)

  request.headers['host'] = request.host
  request.headers['x-amz-date'] = requestDate.format('YYYYMMDDTHHmmSS') + 'Z'
  request.headers['x-amz-content-sha256'] = dataShaSum256

  var canonicalRequestAndSignedHeaders = getCanonicalRequest(request, dataShaSum256)
  var canonicalRequest = canonicalRequestAndSignedHeaders[0]
  var signedHeaders = canonicalRequestAndSignedHeaders[1]
  var hash = Crypto.createHash('sha256')
  hash.update(canonicalRequest)
  var canonicalRequestHash = hash.digest('hex')

  var stringToSign = getStringToSign(canonicalRequestHash, requestDate, region)

  var signingKey = getSigningKey(requestDate, region, secretKey)

  var hmac = Crypto.createHmac('sha256', signingKey)

  hmac.update(stringToSign)
  var signedRequest = hmac.digest('hex').toLowerCase().trim()

  var credentials = `${accessKey}/${requestDate.format('YYYYMMDD')}/${region}/s3/aws4_request`

  request.headers['authorization'] = `AWS4-HMAC-SHA256 Credential=${credentials}, SignedHeaders=${signedHeaders}, Signature=${signedRequest}`

  function getSigningKey(date, region, secretKey) {
    var key = "AWS4" + secretKey
    var dateLine = date.format('YYYYMMDD')

    var hmac1 = Crypto.createHmac('sha256', key).update(dateLine).digest('binary')
    var hmac2 = Crypto.createHmac('sha256', hmac1).update(region).digest('binary')
    var hmac3 = Crypto.createHmac('sha256', hmac2).update("s3").digest('binary')
    return Crypto.createHmac('sha256', hmac3).update("aws4_request").digest('binary')
  }

  function getCanonicalRequest(request, dataShaSum1) {
    var headerKeys = []
    var headers = []

    for (var key in request.headers) {
      if (request.headers.hasOwnProperty(key)) {
        var value = request.headers[key]
        headers.push(`${key.toLowerCase()}:${value}`)
        headerKeys.push(key.toLowerCase())
      }
    }

    headers.sort()
    headerKeys.sort()

    var signedHeaders = ""
    headerKeys.forEach(element => {
      if (signedHeaders) {
        signedHeaders += ';'
      }
      signedHeaders += element
    })

    var splitPath = request.path.split('?')
    var requestResource = splitPath[0]
    var requestQuery = ''
    if (splitPath.length == 2) {
      requestQuery = splitPath[1]
        .split('&')
        .sort()
        .map(element => {
          if (element.indexOf('=') === -1) {
            element = element + '='
          }
          return element
          })
          .join('&')
      }

      var canonicalString = ""
      canonicalString += canonicalString + request.method.toUpperCase() + '\n'
      canonicalString += requestResource + '\n'
      canonicalString += requestQuery + '\n';
      headers.forEach(element => {
        canonicalString += element + '\n'
      })
      canonicalString += '\n'
      canonicalString += signedHeaders + '\n'
      canonicalString += dataShaSum1
      return [canonicalString, signedHeaders]
    }
  }

  var uriEscape = function uriEscape(string) {
    var output = encodeURIComponent(string);
    output = output.replace(/[^A-Za-z0-9_.~\-%]+/g, escape);

    // AWS percent-encodes some extra non-standard characters in a URI
    output = output.replace(/[*]/g, function(ch) {
      return '%' + ch.charCodeAt(0).toString(16).toUpperCase();
    });

    return output;
  }

  var listAllIncompleteUploads = function(transport, params, bucket, object) {
    "use strict";
    var errorred = null
    var queue = new Stream.Readable({
      objectMode: true
    })
    queue._read = () => {
    }

    var stream = queue.pipe(Through2.obj(function(currentJob, enc, done) {
      if (errorred) {
        return done()
      }
      listMultipartUploads(transport, params, currentJob.bucket, currentJob.object, currentJob.objectMarker, currentJob.uploadIdMarker, (e, r) => {
        if (errorred) {
          return done()
        }
        // TODO handle error
        if (e) {
          return done(e)
        }
        r.uploads.forEach(upload => {
          this.push(upload)
        })
        if (r.isTruncated) {
          queue.push({
            bucket: bucket,
            object: decodeURI(object),
            objectMarker: decodeURI(r.objectMarker),
            uploadIdMarker: decodeURI(r.uploadIdMarker)
          })
        } else {
          queue.push(null)
        }
        done()
      })
    }, function(done) {
      if (errorred) {
        return done(errorred)
      }
      return done()
    }))

    queue.push({
      bucket: bucket,
      object: object,
      objectMarker: null,
      uploadIdMarker: null
    })

    return stream
  }

  function listMultipartUploads(transport, params, bucket, key, keyMarker, uploadIdMarker, cb) {
    "use strict";
    var queries = []
    var escape = uriEscape
    if (key) {
      queries.push(`prefix=${escape(key)}`)
    }
    if (keyMarker) {
      keyMarker = escape(keyMarker)
      queries.push(`key-marker=${keyMarker}`)
    }
    if (uploadIdMarker) {
      uploadIdMarker = escape(uploadIdMarker)
      queries.push(`upload-id-marker=${uploadIdMarker}`)
    }
    var maxuploads = 1000;
    queries.push(`max-uploads=${maxuploads}`)
    queries.sort()
    queries.unshift('uploads')
    var query = ''
    if (queries.length > 0) {
      query = `?${queries.join('&')}`
    }
    var requestParams = {
      host: params.host,
      port: params.port,
      path: `/${bucket}${query}`,
      method: 'GET'
    }

    signV4(requestParams, '', params.accessKey, params.secretKey)

    var req = transport.request(requestParams, (response) => {
      if (response.statusCode !== 200) {
        return parseError(response, cb)
      }
      response.pipe(Concat(xml => {
        var parsedXml = ParseXml(xml.toString())
        var result = {
          uploads: [],
          isTruncated: false,
          nextJob: null
        }
        var nextJob = {
          bucket: bucket,
          key: key
        }
        var ignoreTruncated = false
        parsedXml.root.children.forEach(element => {
          switch (element.name) {
            case "IsTruncated":
              result.isTruncated = element.content === 'true'
              break
            case "NextKeyMarker":
              nextJob.keyMarker = decodeURI(element.content)
              break
            case "NextUploadIdMarker":
              nextJob.uploadIdMarker = decodeURI(element.content)
              break
            case "Upload":
              var upload = {
                bucket: bucket,
                key: null,
                uploadId: null,
              }
              element.children.forEach(xmlObject => {
                switch (xmlObject.name) {
                  case "Key":
                    upload.key = decodeURI(xmlObject.content)
                    break
                  case "UploadId":
                    upload.uploadId = decodeURI(xmlObject.content)
                    break
                  default:
                }
              })
              if (key) {
                if (key === upload.key) {
                  result.uploads.push(upload)
                } else {
                  ignoreTruncated = true
                }
              } else {
                result.uploads.push(upload)
              }
              break
            default:
          }
        })
        if (result.isTruncated && !ignoreTruncated) {
          result.nextJob = nextJob
        } else {
          result.isTruncated = false
        }
        cb(null, result)
      }))
    })
    req.end()
  }

  var abortMultipartUpload = (transport, params, bucket, key, uploadId, cb) => {
    var requestParams = {
      host: params.host,
      port: params.port,
      path: `/${bucket}/${key}?uploadId=${uploadId}`,
      method: 'DELETE'
    }

    signV4(requestParams, '', params.accessKey, params.secretKey)

    var req = transport.request(requestParams, (response) => {
      "use strict";
      if (response.statusCode !== 204) {
        return parseError(response, cb)
      }
      cb()
    })
    req.end()
  }

  var dropUploads = (transport, params, bucket, key, cb) => {
    "use strict";
    var self = this

    var errorred = null

    var queue = new Stream.Readable({
      objectMode: true
    })
    queue._read = () => {
    }
    queue.pipe(Through2.obj(function(job, enc, done) {
      if (errorred) {
        return done()
      }
      listMultipartUploads(transport, params, job.bucket, job.key, job.keyMarker, job.uploadIdMarker, (e, result) => {
        if (errorred) {
          return done()
        }
        if (e) {
          errorred = e
          queue.push(null)
          return done()
        }
        result.uploads.forEach(element => {
          this.push(element)
        })
        if (result.isTruncated) {
          queue.push({
            bucket: result.nextJob.bucket,
            key: result.nextJob.key,
            keyMarker: result.nextJob.keyMarker,
            uploadIdMarker: result.nextJob.uploadIdMarker
          })
        } else {
          queue.push(null)
        }
        done()
      })
    }))
      .pipe(Through2.obj(function(upload, enc, done) {
        if (errorred) {
          return done()
        }
        abortMultipartUpload(transport, params, upload.bucket, upload.key, upload.uploadId, (e) => {
          if (errorred) {
            return done()
          }
          if (e) {
            errorred = e
            queue.push(null)
            return done()
          }
          done()
        })
      }, function(done) {
        cb(errorred)
        done()
      }))
    queue.push({
      bucket: bucket,
      key: key,
      keyMarker: null,
      uploadIdMarker: null
    })
  }

  var initiateNewMultipartUpload = (transport, params, bucket, key, cb) => {
    var requestParams = {
      host: params.host,
      port: params.port,
      path: `/${bucket}/${key}?uploads`,
      method: 'POST'
    }

    signV4(requestParams, '', params.accessKey, params.secretKey)

    var request = transport.request(requestParams, (response) => {
      if (response.statusCode !== 200) {
        return parseError(response, cb)
      }
      response.pipe(Concat(xml => {
        "use strict";
        var parsedXml = ParseXml(xml.toString())
        var uploadId = null
        parsedXml.root.children.forEach(element => {
          "use strict";
          if (element.name === 'UploadId') {
            uploadId = element.content
          }
        })

        if (uploadId) {
          return cb(null, uploadId)
        }
        cb('unable to get upload id')
      }))
    })
    request.end()
  }

  function doPutObject(transport, params, bucket, key, contentType, size, uploadId, part, r, cb) {
    var query = ''
    if (part) {
      query = `?partNumber=${part}&uploadId=${uploadId}`
    }
    if (contentType == null || contentType == '') {
      contentType = 'aplication/octet-stream'
    }

    r.pipe(Concat(data => {
      var hash256 = Crypto.createHash('sha256')
      var hashMD5 = Crypto.createHash('md5')
      hash256.update(data)
      hashMD5.update(data)

      var sha256 = hash256.digest('hex').toLowerCase()
      var md5 = hashMD5.digest('base64')

      var requestParams = {
        host: params.host,
        port: params.port,
        path: `/${bucket}/${key}${query}`,
        method: 'PUT',
        headers: {
          "Content-Length": size,
          "Content-Type": contentType,
          "Content-MD5": md5
        }
      }

      signV4(requestParams, sha256, params.accessKey, params.secretKey)

      var dataStream = new Stream.Readable()
      dataStream._read = () => {
      }
      dataStream.push(data)
      dataStream.push(null)

      var request = transport.request(requestParams, (response) => {
        if (response.statusCode !== 200) {
          return parseError(response, cb)
        }
        var etag = response.headers['etag']
        cb(null, etag)
      })
      dataStream.pipe(request)
    }, function(done) {
      done()
    }))
    r.on('error', (e) => {
      cb('Unable to read data')
    })
  }

  function completeMultipartUpload(transport, params, bucket, key, uploadId, etags, cb) {
    var requestParams = {
      host: params.host,
      port: params.port,
      path: `/${bucket}/${key}?uploadId=${uploadId}`,
      method: 'POST'
    }

    var parts = []

    etags.forEach(element => {
      parts.push({
        Part: [{
          PartNumber: element.part
        }, {
          ETag: element.etag
        },]
      })
    })

    var payloadObject = {
      CompleteMultipartUpload: parts
    }

    var payload = Xml(payloadObject)

    var hash = Crypto.createHash('sha256')
    hash.update(payload)
    var sha256 = hash.digest('hex').toLowerCase()

    var stream = new Stream.Readable()
    stream._read = () => {
    }
    stream.push(payload)
    stream.push(null)

    signV4(requestParams, sha256, params.accessKey, params.secretKey)

    var request = transport.request(requestParams, (response) => {
      if (response.statusCode !== 200) {
        return parseError(response, cb)
      }
      cb()
    })
    stream.pipe(request)
  }

  var getObjectList = (transport, params, bucket, prefix, marker, delimiter, maxKeys, cb) => {
    var queries = []
    var escape = uriEscape; // escape every value, for query string
    if (prefix) {
      prefix = escape(prefix)
      queries.push(`prefix=${prefix}`)
    }
    if (marker) {
      marker = escape(marker)
      queries.push(`marker=${marker}`)
    }
    if (delimiter) {
      delimiter = escape(delimiter)
      queries.push(`delimiter=${delimiter}`)
    }
    if (maxKeys) {
      maxKeys = escape(maxKeys)
      queries.push(`max-keys=${maxKeys}`)
    }
    queries.sort()
    var query = ''
    if (queries.length > 0) {
      query = `?${queries.join('&')}`
    }
    var requestParams = {
      host: params.host,
      port: params.port,
      path: `/${bucket}${query}`,
      method: 'GET'
    }

    signV4(requestParams, '', params.accessKey, params.secretKey)

    var req = transport.request(requestParams, (response) => {
      if (response.statusCode !== 200) {
        return parseError(response, cb)
      }
      response.pipe(Concat((body) => {
        var xml = ParseXml(body.toString())
        var result = {
          objects: [],
          marker: null,
          isTruncated: false
        }
        var marker = null
        xml.root.children.forEach(element => {
          switch (element.name) {
            case "IsTruncated":
              result.isTruncated = element.content === 'true'
              break
            case "Contents":
              var object = {}
              element.children.forEach(xmlObject => {
                switch (xmlObject.name) {
                  case "Key":
                    object.name = xmlObject.content
                    marker = object.name
                    break
                  case "LastModified":
                    object.lastModified = xmlObject.content
                    break
                  case "Size":
                    object.size = +xmlObject.content
                    break
                  case "ETag":
                    object.etag = xmlObject.content
                    break
                  default:
                }
              })
              result.objects.push(object)
              break
            case "CommonPrefixes": // todo, this is the only known way for now to propagate delimited entries
              var object = {}
              element.children.forEach(xmlPrefix => {
                switch (xmlPrefix.name) {
                  case "Prefix":
                    object.name = xmlPrefix.content
                    object.size = 0
                    break
                  default:
                }
              })
              result.objects.push(object);
              break;
            default:
          }
        })
        // if truncated but no marker set, we set it
        if(!result.marker && result.isTruncated) {
          result.marker = marker
        }
        cb(null, result)
      }))
    })
    req.end()
  }

  var listAllParts = (transport, params, bucket, key, uploadId) => {
    var errorred = null
    var queue = new Stream.Readable({
      objectMode: true
    })
    queue._read = () => {
    }
    var stream = queue
      .pipe(Through2.obj(function(job, enc, done) {
        if (errorred) {
          return done()
        }
        listParts(transport, params, bucket, key, uploadId, job.marker, (e, r) => {
          if (errorred) {
            return done()
          }
          if (e) {
            errorred = e
            queue.push(null)
            return done()
          }
          r.parts.forEach((element) => {
            this.push(element)
          })
          if (r.isTruncated) {
            queue.push(r.nextJob)
          } else {
            queue.push(null)
          }
          done()
        })
      }, function(end) {
        end(errorred)
      }))
    queue.push({
      bucket: bucket,
      key: key,
      uploadId: uploadId,
      marker: 0
    })
    return stream
  }

  var listParts = (transport, params, bucket, key, uploadId, marker, cb) => {
    var query = '?'
    if (marker && marker != 0) {
      query += `part-number-marker=${marker}&`
    }
    query += `uploadId=${uploadId}`
    var requestParams = {
      host: params.host,
      port: params.port,
      path: `/${bucket}/${key}${query}`,
      method: 'GET'
    }

    signV4(requestParams, '', params.accessKey, params.secretKey)

    var request = Http.request(requestParams, (response) => {
      if (response.statusCode !== 200) {
        return parseError(response, cb)
      }
      response.pipe(Concat(body => {
        var xml = ParseXml(body.toString())
        var result = {
          isTruncated: false,
          parts: [],
          nextJob: null
        }
        var nextJob = {
          bucket: bucket,
          key: key,
          uploadId: uploadId
        }
        xml.root.children.forEach(element => {
          switch (element.name) {
            case "IsTruncated":
              result.isTruncated = element.content === 'true'
              break
            case "NextPartNumberMarker":
              nextJob.marker = +element.content
              break
            case "Part":
              var object = {}
              element.children.forEach(xmlObject => {
                switch (xmlObject.name) {
                  case "PartNumber":
                    object.part = +xmlObject.content
                    break
                  case "LastModified":
                    object.lastModified = xmlObject.content
                    break
                  case "ETag":
                    object.etag = xmlObject.content
                    break
                  case "Size":
                    object.size = +xmlObject.content
                    break
                  default:
                }
              })
              result.parts.push(object)
              break
            default:
              break
          }
        })
        if (result.isTruncated) {
          result.nextJob = nextJob
        }
        cb(null, result)
      }))
    })
    request.end()
  }

  function getRegion(host) {
    switch (host) {
      case "s3.amazonaws.com":
        return "us-east-1"
      case "s3-ap-northeast-1.amazonaws.com":
        return "ap-northeast-1"
      case "s3-ap-southeast-1.amazonaws.com":
        return "ap-southeast-1"
      case "s3-ap-southeast-2.amazonaws.com":
        return "ap-southeast-2"
      case "s3-eu-central-1.amazonaws.com":
        return "eu-central-1"
      case "s3-eu-west-1.amazonaws.com":
        return "eu-west-1"
      case "s3-sa-east-1.amazonaws.com":
        return "sa-east-1"
      case "s3-external-1.amazonaws.com":
        return "us-east-1"
      case "s3-us-west-1.amazonaws.com":
        return "us-west-1"
      case "s3-us-west-2.amazonaws.com":
        return "us-west-2"
      case "s3.cn-north-1.amazonaws.com.cn":
        return "cn-north-1"
      case "s3-fips-us-gov-west-1.amazonaws.com":
        return "us-gov-west-1"
      default:
        return "milkyway"
    }
  }

  var inst = Client
  module.exports = inst
