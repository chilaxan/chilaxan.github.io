/* */ 
(function(process) {
  var setupBenchmarks,
      fullFixture,
      quickFixture;
  fullFixture = ['Underscore 1.4.1', 'Backbone 0.9.2', 'CodeMirror 2.34', 'MooTools 1.4.1', 'jQuery 1.8.2', 'jQuery.Mobile 1.2.0', 'Angular 1.0.2', 'three.js r51'];
  quickFixture = ['Backbone 0.9.2', 'jQuery 1.8.2', 'Angular 1.0.2'];
  function slug(name) {
    'use strict';
    return name.toLowerCase().replace(/\.js/g, 'js').replace(/\s/g, '-');
  }
  function kb(bytes) {
    'use strict';
    return (bytes / 1024).toFixed(1);
  }
  if (typeof window !== 'undefined') {
    setupBenchmarks = function() {
      'use strict';
      function id(i) {
        return document.getElementById(i);
      }
      function setText(id, str) {
        var el = document.getElementById(id);
        if (typeof el.innerText === 'string') {
          el.innerText = str;
        } else {
          el.textContent = str;
        }
      }
      function enableRunButtons() {
        id('runquick').disabled = false;
        id('runfull').disabled = false;
      }
      function disableRunButtons() {
        id('runquick').disabled = true;
        id('runfull').disabled = true;
      }
      function createTable() {
        var str = '',
            index,
            test,
            name;
        str += '<table>';
        str += '<thead><tr><th>Source</th><th>Size (KiB)</th>';
        str += '<th>Time (ms)</th><th>Variance</th></tr></thead>';
        str += '<tbody>';
        for (index = 0; index < fullFixture.length; index += 1) {
          test = fullFixture[index];
          name = slug(test);
          str += '<tr>';
          str += '<td>' + test + '</td>';
          str += '<td id="' + name + '-size"></td>';
          str += '<td id="' + name + '-time"></td>';
          str += '<td id="' + name + '-variance"></td>';
          str += '</tr>';
        }
        str += '<tr><td><b>Total</b></td>';
        str += '<td id="total-size"></td>';
        str += '<td id="total-time"></td>';
        str += '<td></td></tr>';
        str += '</tbody>';
        str += '</table>';
        id('result').innerHTML = str;
      }
      function loadTests() {
        var index = 0,
            totalSize = 0;
        function load(test, callback) {
          var xhr = new XMLHttpRequest(),
              src = '3rdparty/' + test + '.js';
          window.data = window.data || {};
          window.data[test] = '';
          try {
            xhr.timeout = 30000;
            xhr.open('GET', src, true);
            xhr.ontimeout = function() {
              setText('status', 'Error: time out while loading ' + test);
              callback.apply();
            };
            xhr.onreadystatechange = function() {
              var success = false,
                  size = 0;
              if (this.readyState === XMLHttpRequest.DONE) {
                if (this.status === 200) {
                  window.data[test] = this.responseText;
                  size = this.responseText.length;
                  totalSize += size;
                  success = true;
                }
              }
              if (success) {
                setText(test + '-size', kb(size));
              } else {
                setText('status', 'Please wait. Error loading ' + src);
                setText(test + '-size', 'Error');
              }
              callback.apply();
            };
            xhr.send(null);
          } catch (e) {
            setText('status', 'Please wait. Error loading ' + src);
            callback.apply();
          }
        }
        function loadNextTest() {
          var test;
          if (index < fullFixture.length) {
            test = fullFixture[index];
            index += 1;
            setText('status', 'Please wait. Loading ' + test + ' (' + index + ' of ' + fullFixture.length + ')');
            window.setTimeout(function() {
              load(slug(test), loadNextTest);
            }, 100);
          } else {
            setText('total-size', kb(totalSize));
            setText('status', 'Ready.');
            enableRunButtons();
          }
        }
        loadNextTest();
      }
      function runBenchmarks(suite) {
        var index = 0,
            totalTime = 0;
        function reset() {
          var i,
              name;
          for (i = 0; i < fullFixture.length; i += 1) {
            name = slug(fullFixture[i]);
            setText(name + '-time', '');
            setText(name + '-variance', '');
          }
          setText('total-time', '');
        }
        function run() {
          var el,
              test,
              source,
              benchmark;
          if (index >= suite.length) {
            setText('total-time', (1000 * totalTime).toFixed(1));
            setText('status', 'Ready.');
            enableRunButtons();
            return;
          }
          test = slug(suite[index]);
          el = id(test);
          source = window.data[test];
          setText(test + '-time', 'Running...');
          window.tree = [];
          benchmark = new window.Benchmark(test, function(o) {
            var syntax = window.esprima.parse(source);
            window.tree.push(syntax.body.length);
          }, {'onComplete': function() {
              setText(this.name + '-time', (1000 * this.stats.mean).toFixed(1));
              setText(this.name + '-variance', (1000 * this.stats.variance).toFixed(1));
              totalTime += this.stats.mean;
            }});
          window.setTimeout(function() {
            benchmark.run();
            index += 1;
            window.setTimeout(run, 211);
          }, 211);
        }
        disableRunButtons();
        setText('status', 'Please wait. Running benchmarks...');
        reset();
        run();
      }
      id('runquick').onclick = function() {
        runBenchmarks(quickFixture);
      };
      id('runfull').onclick = function() {
        runBenchmarks(fullFixture);
      };
      setText('benchmarkjs-version', ' version ' + window.Benchmark.version);
      setText('version', window.esprima.version);
      createTable();
      disableRunButtons();
      loadTests();
    };
  } else {
    (function(global) {
      'use strict';
      var Benchmark,
          esprima,
          dirname,
          option,
          fs,
          readFileSync,
          log;
      if (typeof require === 'undefined') {
        dirname = 'test';
        load(dirname + '/3rdparty/benchmark.js');
        load(dirname + '/../esprima.js');
        Benchmark = global.Benchmark;
        esprima = global.esprima;
        readFileSync = global.read;
        log = print;
      } else {
        Benchmark = require('./3rdparty/benchmark');
        esprima = require('../esprima');
        fs = require('fs');
        option = process.argv[2];
        readFileSync = function readFileSync(filename) {
          return fs.readFileSync(filename, 'utf-8');
        };
        dirname = __dirname;
        log = console.log.bind(console);
      }
      function runTests(tests) {
        var index,
            tree = [],
            totalTime = 0,
            totalSize = 0;
        tests.reduce(function(suite, filename) {
          var source = readFileSync(dirname + '/3rdparty/' + slug(filename) + '.js'),
              size = source.length;
          totalSize += size;
          return suite.add(filename, function() {
            var syntax = esprima.parse(source);
            tree.push(syntax.body.length);
          }, {'onComplete': function(event, bench) {
              log(this.name + ' size ' + kb(size) + ' time ' + (1000 * this.stats.mean).toFixed(1) + ' variance ' + (1000 * 1000 * this.stats.variance).toFixed(1));
              totalTime += this.stats.mean;
            }});
        }, new Benchmark.Suite()).on('complete', function() {
          log('Total size ' + kb(totalSize) + ' time ' + (1000 * totalTime).toFixed(1));
        }).run();
      }
      if (option === 'quick') {
        runTests(quickFixture);
      } else {
        runTests(fullFixture);
      }
    }(this));
  }
})(require('process'));
